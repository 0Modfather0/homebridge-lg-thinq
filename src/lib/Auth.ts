import crypto from 'crypto';
import { DateTime } from 'luxon';
import qs from 'qs';
import { URL } from 'url';
import { AuthenticationError, ManualProcessNeededErrorCode, TokenError } from '../errors/index.js';
import * as constants from './constants.js';
import { Gateway } from './Gateway.js';
import { requestClient } from './request.js';
import { Session } from './Session.js';
import { Logger } from 'homebridge';
import { createNoopLogger } from './noopLogger.js';

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }

  if (typeof value === 'number') {
    return value.toString();
  }

  return null;
}

function authResponseData(err: unknown): Record<string, unknown> | null {
  const response = recordValue(err)?.response;
  return recordValue(recordValue(response)?.data);
}

function errorCause(err: unknown): unknown {
  return recordValue(err)?.cause;
}

export function authErrorCode(err: unknown): string | null {
  const data = authResponseData(err);
  const error = recordValue(data?.error);

  return stringValue(error?.code)
    || stringValue(data?.resultCode)
    || stringValue(recordValue(err)?.code)
    || (errorCause(err) ? authErrorCode(errorCause(err)) : null);
}

export function authErrorMessage(err: unknown, fallback: string): string {
  const data = authResponseData(err);
  const error = recordValue(data?.error);

  return stringValue(error?.message)
    || stringValue(data?.message)
    || stringValue(data?.error_description)
    || stringValue(data?.returnMsg)
    || (err instanceof Error ? stringValue(err.message) : null)
    || (errorCause(err) ? authErrorMessage(errorCause(err), fallback) : null)
    || fallback;
}

export function authHttpStatus(err: unknown): number | null {
  const error = recordValue(err);
  const response = recordValue(error?.response);
  const status = error?.status ?? response?.status;

  if (typeof status === 'number') {
    return status;
  }

  const cause = errorCause(err);
  return cause ? authHttpStatus(cause) : null;
}

function authError(context: string, err: unknown): AuthenticationError {
  const message = authErrorMessage(err, 'Request failed.');
  const error = new AuthenticationError(`${context}: ${message}`);
  (error as Error & { cause?: unknown }).cause = err;

  return error;
}

/**
 * Handles authentication with the LG ThinQ API.
 * This class manages login, token refresh, and user session handling.
 */
export class Auth {
  /**
   * The base URL for the LG API, determined by the user's country code.
   */
  public lgeapi_url: string;

  /**
   * Creates a new `Auth` instance.
   *
   * @param gateway - The `Gateway` instance containing API endpoint information.
   * @param logger - The logger instance for logging debug and error messages.
   */
  public constructor(
    protected gateway: Gateway,
    public logger: Logger = createNoopLogger(),
  ) {
    this.lgeapi_url = `https://${this.gateway.country_code.toLowerCase()}.lgeapi.com/`;
  }

  /**
   * Logs in to the LG ThinQ API using the provided username and password.
   *
   * @param username - The user's username.
   * @param password - The user's password.
   * @returns A promise that resolves with a `Session` instance.
   */
  public async login(username: string, password: string) {
    const hash = crypto.createHash('sha512');
    const encryptedPassword = hash.update(password).digest('hex');

    // LG removed the secret-key lookup used by the legacy EMP session flow.
    // Prefer the current lgemembers.com flow, while retaining legacy support
    // for regions where it may still be available.
    try {
      return await this.loginNew(username, encryptedPassword);
    } catch (err: unknown) {
      if (err instanceof AuthenticationError) {
        throw err;
      }

      this.logger.warn(
        `Current LG account sign-in failed (${authErrorMessage(err, 'unknown error')}); trying the legacy flow.`,
      );
      return this.loginStep2(username, encryptedPassword);
    }
  }

  /**
   * Signs in through LG's current lgemembers.com account system.
   *
   * Adapted from mp-consulting/homebridge-lg-thinq, Apache-2.0 licensed.
   */
  public async loginNew(username: string, encryptedPassword: string) {
    const country = this.gateway.country_code;
    const language = this.gateway.language_code;
    const host = `https://${country.toLowerCase()}.${constants.LGACC_BASE_URL}`;
    const headers = {
      'Accept': '*/*',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept-Language': `${language},${country.toLowerCase()};q=0.9`,
      'Origin': host,
      'User-Agent': constants.EMP_USER_AGENT,
    };

    const signInParams = {
      callback_url: constants.LGACC_REDIRECT_URI,
      client_id: constants.CLIENT_ID,
      close_type: '0',
      country,
      language,
      pre_login: '',
      redirect_url: constants.LGACC_REDIRECT_URI,
      state: 'signin',
      svc_code: constants.SVC_CODE,
      svc_integrated: 'Y',
      ui_mode: 'light',
      webview_yn: 'Y',
    };
    const pageResponse = await requestClient.get(
      `${host}/lgacc/service/v1/signin?${qs.stringify(signInParams)}`,
      {
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': headers['Accept-Language'],
          'User-Agent': constants.EMP_USER_AGENT,
        },
      },
    );
    const cookie = this.firstCookie(pageResponse.headers['set-cookie']);

    const accountResponse = await requestClient.post(
      `${host}/lgacc/front/v1/signin/signInAct`,
      qs.stringify({
        clientId: constants.CLIENT_ID,
        doneYn: '',
        ipadYn: 'N',
        itgTermsUseFlag: 'Y',
        itgUserType: 'A',
        local_country: country,
        local_lang: language.split('-')[0],
        skipYn: 'N',
        svcCode: constants.SVC_CODE,
        svc_code: constants.SVC_CODE,
        userId: encodeURIComponent(this.encryptUserId(username)),
        userPw: encryptedPassword,
      }),
      { headers: { ...headers, Cookie: cookie } },
    );

    const account = accountResponse.data?.account;
    if (!account) {
      const { code, message } = accountResponse.data?.error || {};
      if (code === 'MS.001.03') {
        throw new AuthenticationError(`Your account was already used to registered in ${message}.`);
      }

      throw new AuthenticationError(
        message || accountResponse.data?.message
        || 'LG rejected the sign-in. If this account uses Apple, Google, or Facebook sign-in, use a dedicated LG account.',
      );
    }

    const loginSessionID = account.loginSessionID;
    const loginUuid = crypto.randomUUID();
    const completeResponse = await requestClient.post(
      `${host}/lgacc/front/v1/signin/signInComplete`,
      qs.stringify({
        loginSessionID,
        additionalInfo: encodeURIComponent(JSON.stringify({
          uuid: loginUuid,
          user_id: account.userID,
          user_id_type: account.userIDType,
          svc_integrated: 'Y',
        })),
        autoYn: 'N',
        deviceId: this.randomString(32),
        ipadYn: 'N',
        local_country: country,
        local_lang: language.split('-')[0],
        serviceYn: 'Y',
        svcCode: constants.SVC_CODE,
        svc_code: constants.SVC_CODE,
        uuid: loginUuid,
      }),
      { headers: { ...headers, Cookie: cookie } },
    );

    if (completeResponse.data?.code !== 'SUCCESS') {
      throw new TokenError(completeResponse.data?.message || JSON.stringify(completeResponse.data));
    }
    const sessionCookie = this.firstCookie(completeResponse.headers['set-cookie']) || cookie;

    await requestClient.post(
      `${host}/lgacc/front/v1/signin/token`,
      qs.stringify({ loginSessionID, uuid: loginUuid }),
      { headers: { ...headers, Cookie: sessionCookie } },
    );

    const oauthResponse = await requestClient.post(
      `${host}/lgacc/front/v1/signin/oauth`,
      qs.stringify({
        loginSessionID,
        accountType: 'LGE',
        clientId: constants.CLIENT_ID,
        countryCode: country,
        local_country: country,
        local_lang: language.split('-')[0],
        redirectUri: constants.LGACC_REDIRECT_URI,
        state: 'signin',
        svc_code: constants.SVC_CODE,
        userName: username,
      }),
      { headers: { ...headers, Cookie: sessionCookie } },
    );

    const redirectUri = oauthResponse.data?.redirect_uri;
    if (!redirectUri) {
      throw new TokenError(oauthResponse.data?.message || JSON.stringify(oauthResponse.data));
    }
    const code = qs.parse(decodeURIComponent(redirectUri).split('?')[1])?.code;
    if (!code || typeof code !== 'string') {
      throw new TokenError('LG returned no authorization code.');
    }

    return this.requestToken({ code, grant_type: 'authorization_code' });
  }

  protected encryptUserId(username: string) {
    return crypto.publicEncrypt({
      key: constants.LGACC_PUBLIC_KEY,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    }, Buffer.from(username)).toString('base64');
  }

  protected firstCookie(setCookie?: string[]) {
    return setCookie?.[0]?.split(';')[0] || '';
  }

  protected randomString(length: number) {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length }, () => characters[crypto.randomInt(characters.length)]).join('');
  }

  protected async requestToken(data: Record<string, string>, backendUrl?: string) {
    const tokenData = { ...data, redirect_uri: constants.LGACC_REDIRECT_URI };
    const timestamp = DateTime.utc().toRFC2822();
    const requestUrl = `/oauth/1.0/oauth2/token?${qs.stringify(tokenData)}`;
    const baseUrl = backendUrl || this.lgeapi_url;
    const tokenUrl = `${baseUrl.replace(/\/?$/, '/')}oauth/1.0/oauth2/token`;

    const res = await requestClient.post(tokenUrl, qs.stringify(tokenData), {
      headers: {
        'x-lge-app-os': 'ADR',
        'x-lge-appkey': constants.CLIENT_ID,
        'x-lge-oauth-signature': this.signature(`${requestUrl}\n${timestamp}`, constants.OAUTH_SECRET_KEY),
        'x-lge-oauth-date': timestamp,
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }).catch(err => {
      throw authError('LG token exchange failed', err);
    });
    const token = res.data;

    this.lgeapi_url = token.oauth2_backend_url || this.lgeapi_url;
    return new Session(
      token.access_token,
      token.refresh_token,
      Session.expiryTimestampFromExpiresIn(parseInt(token.expires_in, 10)),
    );
  }

  /**
   * Performs the second step of the login process using an encrypted password.
   *
   * @param username - The user's username.
   * @param encrypted_password - The encrypted password.
   * @param extra_headers - Optional additional headers for the request.
   * @returns A promise that resolves with a `Session` instance.
   */
  public async loginStep2(username: string, encrypted_password: string, extra_headers?: any) {
    const headers: Record<string, string> = this.defaultEmpHeaders;

    const preLoginData = {
      'user_auth2': encrypted_password,
      'log_param': 'login request / user_id : ' + username + ' / third_party : null / svc_list : SVC202,SVC710 / 3rd_service : ',
    };
    const preLogin = await requestClient.post(this.gateway.login_base_url + 'preLogin', qs.stringify(preLoginData), { headers })
      .then(res => res.data)
      .catch(err => {
        throw authError('LG pre-login failed', err);
      });

    headers['X-Signature'] = preLogin.signature;
    headers['X-Timestamp'] = preLogin.tStamp;

    const data = {
      'user_auth2': preLogin.encrypted_pw,
      'password_hash_prameter_flag': 'Y',
      'svc_list': 'SVC202,SVC710', // SVC202=LG SmartHome, SVC710=EMP OAuth
      ...extra_headers,
    };

    // try login with username and hashed password
    const loginUrl = this.gateway.emp_base_url + 'emp/v2.0/account/session/' + encodeURIComponent(username);
    const account = await requestClient.post(loginUrl, qs.stringify(data), { headers }).then(res => res.data.account).catch(err => {
      const code = authErrorCode(err);
      const message = authErrorMessage(err, 'LG account login failed.');

      if (code === 'MS.001.03') {
        throw new AuthenticationError('Your account was already used to registered in ' + message + '.');
      }

      throw new AuthenticationError(message);
    });

    // dynamic get secret key for emp signature
    const empSearchKeyUrl = this.gateway.login_base_url + 'searchKey?key_name=OAUTH_SECRETKEY&sever_type=OP';
    const secretKey = await requestClient.get(empSearchKeyUrl).then(res => res.data).then(data => data.returnData)
      .catch(err => {
        if (authHttpStatus(err) === 404) {
          this.logger.warn('LG OAuth key lookup endpoint is unavailable; using the bundled application key.');
          return constants.OAUTH_SECRET_KEY;
        }

        throw authError('LG OAuth key lookup failed', err);
      });

    const timestamp = DateTime.utc().toRFC2822();
    const empData = {
      account_type: account.userIDType,
      client_id: constants.CLIENT_ID,
      country_code: account.country,
      redirect_uri: 'lgaccount.lgsmartthinq:/',
      response_type: 'code',
      state: '12345',
      username: account.userID,
    };
    const empUrl = new URL('https://emp-oauth.lgecloud.com/emp/oauth2/authorize/empsession?' + qs.stringify(empData));
    const signature = this.signature(`${empUrl.pathname}${empUrl.search}\n${timestamp}`, secretKey);
    const empHeaders = {
      'lgemp-x-app-key': constants.OAUTH_CLIENT_KEY,
      'lgemp-x-date': timestamp,
      'lgemp-x-session-key': account.loginSessionID,
      'lgemp-x-signature': signature,
      'Accept': 'application/json',
      'X-Device-Type': 'M01',
      'X-Device-Platform': 'ADR',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Access-Control-Allow-Origin': '*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.9',

      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/93.0.4577.63 Safari/537.36 Edg/93.0.961.44',
    };
    // create emp session and get access token
    const authorize = await requestClient.get(empUrl.href, {
      headers: empHeaders,
    }).then(res => res.data).catch(err => {
      throw authError('LG OAuth authorization failed', err);
    });
    if (authorize.status !== 1) {
      throw new TokenError(authorize.message || authorize);
    }

    const redirect_uri = new URL(authorize.redirect_uri);

    return this.requestToken(
      {
        code: redirect_uri.searchParams.get('code') || '',
        grant_type: 'authorization_code',
      },
      redirect_uri.searchParams.get('oauth2_backend_url') || undefined,
    );
  }

  /**
   * Retrieves the default headers for EMP requests.
   */
  public get defaultEmpHeaders() {
    return {
      'Accept': 'application/json',
      'X-Application-Key': constants.APPLICATION_KEY,
      'X-Client-App-Key': constants.CLIENT_ID,
      'X-Lge-Svccode': 'SVC709',
      'X-Device-Type': 'M01',
      'X-Device-Platform': 'ADR',
      'X-Device-Language-Type': 'IETF',
      'X-Device-Publish-Flag': 'Y',
      'X-Device-Country': this.gateway.country_code,
      'X-Device-Language': this.gateway.language_code,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Access-Control-Allow-Origin': '*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.9',
    };
  }

  /**
   * Handles new terms and conditions that require user agreement.
   *
   * @param accessToken - The access token for the session.
   */
  public async handleNewTerm(accessToken: string) {
    const showTermUrl = 'common/showTerms?callback_url=lgaccount.lgsmartthinq:/updateTerms'
      + '&country=VN&language=en-VN&division=ha:T20&terms_display_type=3&svc_list=SVC202';
    const showTermHtml = await requestClient.get(this.gateway.login_base_url + showTermUrl, {
      headers: {
        'X-Login-Session': accessToken,
      },
    }).then(res => res.data);

    const headers = {
      ...this.defaultEmpHeaders,
      'X-Login-Session': accessToken,
      'X-Signature': showTermHtml.match(/signature[\s]+:[\s]+"([^"]+)"/)[1],
      'X-Timestamp': showTermHtml.match(/tStamp[\s]+:[\s]+"([^"]+)"/)[1],
    };

    const accountTermUrl = 'emp/v2.0/account/user/terms?opt_term_cond=001&term_data=SVC202&itg_terms_use_flag=Y&dummy_terms_use_flag=Y';
    const accountTerms = (await requestClient.get(this.gateway.emp_base_url + accountTermUrl, { headers })
      .then(res => {
        return res.data.account?.terms;
      }))
      .map((term: any) => {
        return term.termsID;
      });

    const termInfoUrl = 'emp/v2.0/info/terms?opt_term_cond=001&only_service_terms_flag=&itg_terms_use_flag=Y&term_data=SVC202';
    const infoTerms = await requestClient.get(this.gateway.emp_base_url + termInfoUrl, { headers }).then(res => {
      return res.data.info.terms;
    });

    const newTermAgreeNeeded = infoTerms.filter((term: any) => {
      return accountTerms.indexOf(term.termsID) === -1;
    }).map((term: any) => {
      return [term.termsType, term.termsID, term.defaultLang].join(':');
    }).join(',');

    if (newTermAgreeNeeded) {
      const updateAccountTermUrl = 'emp/v2.0/account/user/terms';
      await requestClient.post(this.gateway.emp_base_url + updateAccountTermUrl, qs.stringify({ terms: newTermAgreeNeeded }), {
        headers,
      });
    }
  }

  /**
   * Retrieves the JSession ID for ThinQ v1 API compatibility.
   *
   * @param accessToken - The access token for the session.
   * @returns A promise that resolves with the JSession ID.
   */
  public async getJSessionId(accessToken: string) {
    // login to old gateway also - thinq v1
    const memberLoginUrl = this.gateway.thinq1_url + 'member/login';
    const memberLoginHeaders = {
      'x-thinq-application-key': 'wideq',
      'x-thinq-security-key': 'nuts_securitykey',
      'Accept': 'application/json',
      'x-thinq-token': accessToken,
    };
    const memberLoginData = {
      countryCode: this.gateway.country_code,
      langCode: this.gateway.language_code,
      loginType: 'EMP',
      token: accessToken,
    };

    return await requestClient.post(memberLoginUrl, { lgedmRoot: memberLoginData }, {
      headers: memberLoginHeaders,
    })
      .then(res => res.data)
      .then(data => data.lgedmRoot.jsessionId)
      .catch(err => {
        this.logger.debug(
          err.message.startsWith(ManualProcessNeededErrorCode)
            ? 'Please open the native LG App and sign in to your account to see what happened,'
            + ' maybe new agreement need your accept. Then try restarting Homebridge.'
            : err.message,
        );
        this.logger.debug(err);
        this.logger.info('Failed to login to old thinq v1 gateway. See debug logs for more details. Continuing anyways.');
      });
  }

  /**
   * Refreshes the access token using the refresh token.
   *
   * @param session - The current `Session` instance.
   * @returns A promise that resolves with the updated `Session` instance.
   */
  public async refreshNewToken(session: Session) {
    try {
      const gateway = await requestClient.post('https://kic.lgthinq.com:46030/api/common/gatewayUriList', {
        lgedmRoot: {
          countryCode: this.gateway.country_code,
          langCode: this.gateway.language_code,
        },
      }, {
        headers: {
          'Accept': 'application/json',
          'x-thinq-application-key': 'wideq',
          'x-thinq-security-key': 'nuts_securitykey',
        },
      }).then(res => res.data.lgedmRoot);

      this.lgeapi_url = gateway.oauthUri + '/';
    } catch (err) {
      // ignore this error
    }

    const tokenUrl = this.lgeapi_url + 'oauth/1.0/oauth2/token';
    const data = {
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
    };

    const timestamp = DateTime.utc().toRFC2822();

    const requestUrl = '/oauth/1.0/oauth2/token' + qs.stringify(data, { addQueryPrefix: true });
    const signature = this.signature(`${requestUrl}\n${timestamp}`, constants.OAUTH_SECRET_KEY);

    const headers = {
      'x-lge-app-os': 'ADR',
      'x-lge-appkey': constants.CLIENT_ID,
      'x-lge-oauth-signature': signature,
      'x-lge-oauth-date': timestamp,
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    const resp = await requestClient.post(tokenUrl, qs.stringify(data), { headers }).then(resp => resp.data);

    session.newTokenFromExpiresIn(resp.access_token, parseInt(resp.expires_in, 10));

    return session;
  }

  /**
   * Retrieves the user's unique number from the LG API.
   *
   * @param accessToken - The access token for the session.
   * @returns A promise that resolves with the user's unique number.
   */
  public async getUserNumber(accessToken: string) {
    const profileUrl = this.lgeapi_url + 'users/profile';
    const timestamp = DateTime.utc().toRFC2822();
    const signature = this.signature(`/users/profile\n${timestamp}`, constants.OAUTH_SECRET_KEY);

    const headers = {
      'Accept': 'application/json',
      'Authorization': 'Bearer ' + accessToken,
      'X-Lge-Svccode': 'SVC202',
      'X-Application-Key': constants.APPLICATION_KEY,
      'lgemp-x-app-key': constants.CLIENT_ID,
      'X-Device-Type': 'M01',
      'X-Device-Platform': 'ADR',
      'x-lge-oauth-date': timestamp,
      'x-lge-oauth-signature': signature,
    };

    const resp = await requestClient.get(profileUrl, { headers }).then(resp => resp.data);
    if (resp.status === 2) {
      throw new AuthenticationError(resp.message);
    }

    return resp.account.userNo as string;
  }

  /**
   * Constructs the login URL for the LG ThinQ API.
   *
   * @returns The login URL.
   */
  public async getLoginUrl() {
    const params = {
      country: this.gateway.country_code,
      language: this.gateway.language_code,
      client_id: constants.CLIENT_ID,
      svc_list: constants.SVC_CODE,
      svc_integrated: 'Y',
      redirect_uri: 'lgaccount.lgsmartthinq:/',
      show_thirdparty_login: 'LGE,MYLG,GGL,AMZ,FBK,APPL',
      division: 'ha:T20',
      callback_url: 'lgaccount.lgsmartthinq:/',
      oauth2State: '12345',
      show_select_country: 'N',
    };

    return this.gateway.login_base_url + 'login/signIn' + qs.stringify(params, { addQueryPrefix: true });
  }

  /**
   * Generates a signature for API requests.
   *
   * @param message - The message to sign.
   * @param secret - The secret key used for signing.
   * @returns The generated signature.
   */
  protected signature(message: string, secret: string) {
    return crypto.createHmac('sha1', Buffer.from(secret)).update(message).digest('base64');
  }
}
