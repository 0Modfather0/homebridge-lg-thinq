/* eslint-disable dot-notation */
/* eslint-disable @typescript-eslint/no-require-imports */
import { Auth, authErrorCode, authErrorMessage, authHttpStatus } from './Auth.js';
import { Gateway } from './Gateway.js';
import { Session } from './Session.js';
import { Logger } from 'homebridge';
import { describe, test, beforeEach, expect, jest } from '@jest/globals';
import { AuthenticationError } from '../errors/index.js';

describe('Auth', () => {
  let auth: Auth;
  let mockGateway: Gateway;
  let mockLogger: Logger;

  beforeEach(() => {
    jest.restoreAllMocks();

    mockGateway = new Gateway({
      empTermsUri: 'https://example.com/emp',
      empSpxUri: 'https://example.com/spx',
      thinq2Uri: 'https://example.com/thinq2',
      thinq1Uri: 'https://example.com/thinq1',
      countryCode: 'US',
      languageCode: 'en-US',
    });

    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;

    auth = new Auth(mockGateway, mockLogger);
  });

  test('should initialize with correct API URL', () => {
    expect(auth.lgeapi_url).toBe('https://us.lgeapi.com/');
  });

  test('can be constructed by JavaScript callers without a logger', () => {
    const authWithoutLogger = new Auth(mockGateway);

    expect(authWithoutLogger.lgeapi_url).toBe('https://us.lgeapi.com/');
    expect(() => authWithoutLogger.logger.debug('debug')).not.toThrow();
  });

  test('should generate default EMP headers', () => {
    const headers = auth.defaultEmpHeaders;
    expect(headers['X-Device-Country']).toBe('US');
    expect(headers['X-Device-Language']).toBe('en-US');
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded;charset=UTF-8');
  });

  test('should login and return a session', async () => {
    const mockSession = new Session('accessToken', 'refreshToken', Date.now() + 3600 * 1000);
    jest.spyOn(auth, 'loginNew').mockResolvedValueOnce(mockSession);

    const session = await auth.login('testUser', 'testPassword');
    expect(session).toBe(mockSession);
    expect(auth.loginNew).toHaveBeenCalledWith('testUser', expect.any(String));
  });

  test('falls back to the legacy login for non-authentication failures', async () => {
    const mockSession = new Session('accessToken', 'refreshToken', Date.now() + 3600 * 1000);
    jest.spyOn(auth, 'loginNew').mockRejectedValueOnce(new Error('New endpoint unavailable'));
    jest.spyOn(auth, 'loginStep2').mockResolvedValueOnce(mockSession);

    await expect(auth.login('testUser', 'testPassword')).resolves.toBe(mockSession);
    expect(auth.loginStep2).toHaveBeenCalledWith('testUser', expect.any(String));
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('New endpoint unavailable'));
  });

  test('does not retry invalid credentials through the legacy login', async () => {
    jest.spyOn(auth, 'loginNew').mockRejectedValueOnce(new AuthenticationError('Invalid credentials'));
    const legacySpy = jest.spyOn(auth, 'loginStep2');

    await expect(auth.login('testUser', 'testPassword')).rejects.toThrow('Invalid credentials');
    expect(legacySpy).not.toHaveBeenCalled();
  });

  test('logs in through the current LG account flow', async () => {
    const requestClient = require('./request').requestClient;
    jest.spyOn(
      auth as unknown as { encryptUserId(username: string): string },
      'encryptUserId',
    ).mockReturnValue('encrypted-user');
    jest.spyOn(
      auth as unknown as { randomString(length: number): string },
      'randomString',
    ).mockReturnValue('device-id');

    jest.spyOn(requestClient, 'get').mockResolvedValueOnce({
      headers: { 'set-cookie': ['initial-cookie=one; Path=/; Secure'] },
      data: '<html></html>',
    });
    const postSpy = jest.spyOn(requestClient, 'post')
      .mockResolvedValueOnce({ data: { account: {
        loginSessionID: 'session-id',
        userID: 'testUser',
        userIDType: 'LGE',
      } } })
      .mockResolvedValueOnce({
        data: { code: 'SUCCESS' },
        headers: { 'set-cookie': ['session-cookie=two; Path=/; Secure'] },
      })
      .mockResolvedValueOnce({ data: { code: 'SUCCESS' } })
      .mockResolvedValueOnce({ data: {
        redirect_uri: 'lgaccount.lgsmartthinq%3A%2F%3Fcode%3Dauthorization-code',
      } })
      .mockResolvedValueOnce({ data: {
        access_token: 'accessToken',
        refresh_token: 'refreshToken',
        expires_in: 3600,
      } });

    const session = await auth.loginNew('testUser', 'hashed-password');

    expect(session.accessToken).toBe('accessToken');
    expect(session.refreshToken).toBe('refreshToken');
    expect(session.hasValidToken()).toBe(true);
    expect(postSpy).toHaveBeenNthCalledWith(
      1,
      'https://us.lgemembers.com/lgacc/front/v1/signin/signInAct',
      expect.stringContaining('userId=encrypted-user'),
      expect.objectContaining({ headers: expect.objectContaining({ Cookie: 'initial-cookie=one' }) }),
    );
    expect(postSpy).toHaveBeenNthCalledWith(
      4,
      'https://us.lgemembers.com/lgacc/front/v1/signin/oauth',
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ Cookie: 'session-cookie=two' }) }),
    );
    expect(postSpy).toHaveBeenNthCalledWith(
      5,
      'https://us.lgeapi.com/oauth/1.0/oauth2/token',
      expect.stringContaining('code=authorization-code'),
      expect.any(Object),
    );
  });

  test('extracts LG auth error details from response payloads', () => {
    const err = {
      response: {
        data: {
          error: {
            code: 'MS.001.03',
            message: 'Account already registered.',
          },
        },
      },
    };

    expect(authErrorCode(err)).toBe('MS.001.03');
    expect(authErrorMessage(err, 'fallback')).toBe('Account already registered.');
    expect(authErrorMessage(new Error('Network down'), 'fallback')).toBe('Network down');
    expect(authErrorMessage({ cause: new Error('Socket closed') }, 'fallback')).toBe('Socket closed');
    expect(authErrorMessage({}, 'fallback')).toBe('fallback');
  });

  test('extracts HTTP status from Axios-style errors and nested causes', () => {
    expect(authHttpStatus({ response: { status: 404 } })).toBe(404);
    expect(authHttpStatus({ status: 403 })).toBe(403);
    expect(authHttpStatus({ cause: { response: { status: 500 } } })).toBe(500);
    expect(authHttpStatus({})).toBeNull();
  });

  test('should handle loginStep2 and return a session', async () => {
    const mockPreLoginResponse = {
      signature: 'mockSignature',
      tStamp: 'mockTimestamp',
      encrypted_pw: 'mockEncryptedPassword',
    };
    const mockAccountResponse = {
      account: {
        userIDType: 'EMP',
        country: 'US',
        userID: 'testUser',
        loginSessionID: 'session123',
      },
    };
    const mockSecretKeyResponse = { returnData: 'mockSecretKey' };
    const mockAuthorizeResponse = {
      status: 1,
      redirect_uri: 'https://example.com/oauth?code=mockCode',
    };
    const mockTokenResponse = {
      access_token: 'accessToken',
      refresh_token: 'refreshToken',
      expires_in: 3600,
      oauth2_backend_url: 'https://example.com/oauth',
    };

    jest.spyOn(auth['gateway'], 'emp_base_url', 'get').mockReturnValue('https://example.com/emp/');
    jest.spyOn(auth['gateway'], 'login_base_url', 'get').mockReturnValue('https://example.com/spx/');
    jest.spyOn(auth['gateway'], 'country_code', 'get').mockReturnValue('US');
    jest.spyOn(auth['gateway'], 'language_code', 'get').mockReturnValue('en-US');

    // jest.spyOn(auth['defaultEmpHeaders'], 'toString').mockReturnValueOnce('');

    const requestClient = require('./request').requestClient;
    jest.spyOn(requestClient, 'post')
      .mockResolvedValueOnce({ data: mockPreLoginResponse }) // Mock preLogin response
      .mockResolvedValueOnce({ data: mockAccountResponse }) // Mock account response
      .mockResolvedValueOnce({ data: mockTokenResponse }); // Mock token response

    jest.spyOn(requestClient, 'get')
      .mockResolvedValueOnce({ data: mockSecretKeyResponse }) // Mock secret key response
      .mockResolvedValueOnce({ data: mockAuthorizeResponse }); // Mock authorize response

    const session = await auth.loginStep2('testUser', 'mockEncryptedPassword');
    expect(session).toBeInstanceOf(Session);
    expect(session.accessToken).toBe('accessToken');
    expect(session.refreshToken).toBe('refreshToken');
    expect(session.hasValidToken()).toBe(true);
  });

  test('uses the bundled OAuth key when LG removes the dynamic key endpoint', async () => {
    const requestClient = require('./request').requestClient;
    jest.spyOn(requestClient, 'post')
      .mockResolvedValueOnce({ data: {
        signature: 'mockSignature',
        tStamp: 'mockTimestamp',
        encrypted_pw: 'mockEncryptedPassword',
      } })
      .mockResolvedValueOnce({ data: { account: {
        userIDType: 'EMP',
        country: 'US',
        userID: 'testUser',
        loginSessionID: 'session123',
      } } })
      .mockResolvedValueOnce({ data: {
        access_token: 'accessToken',
        refresh_token: 'refreshToken',
        expires_in: 3600,
      } });
    jest.spyOn(requestClient, 'get')
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockResolvedValueOnce({ data: {
        status: 1,
        redirect_uri: 'https://example.com/oauth?code=mockCode',
      } });
    const signatureSpy = jest.spyOn(
      auth as unknown as { signature(message: string, secret: string): string },
      'signature',
    );

    const session = await auth.loginStep2('testUser', 'mockEncryptedPassword');

    expect(session.refreshToken).toBe('refreshToken');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'LG OAuth key lookup endpoint is unavailable; using the bundled application key.',
    );
    expect(signatureSpy).toHaveBeenCalledWith(expect.any(String), 'c053c2a6ddeb7ad97cb0eed0dcb31cf8');
  });

  test('does not hide non-404 OAuth key lookup failures', async () => {
    const requestClient = require('./request').requestClient;
    jest.spyOn(requestClient, 'post')
      .mockResolvedValueOnce({ data: {
        signature: 'mockSignature',
        tStamp: 'mockTimestamp',
        encrypted_pw: 'mockEncryptedPassword',
      } })
      .mockResolvedValueOnce({ data: { account: {
        userIDType: 'EMP',
        country: 'US',
        userID: 'testUser',
        loginSessionID: 'session123',
      } } });
    jest.spyOn(requestClient, 'get')
      .mockRejectedValueOnce({ response: { status: 500 }, message: 'Request failed with status code 500' });

    const promise = auth.loginStep2('testUser', 'mockEncryptedPassword');

    await expect(promise).rejects.toThrow('LG OAuth key lookup failed');
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  test('should refresh tokens using expires_in as a duration', async () => {
    const requestClient = require('./request').requestClient;
    const session = new Session('oldAccessToken', 'refreshToken', 0);

    jest.spyOn(requestClient, 'post')
      .mockResolvedValueOnce({ data: { lgedmRoot: { oauthUri: 'https://oauth.example.com' } } })
      .mockResolvedValueOnce({ data: { access_token: 'newAccessToken', expires_in: '3600' } });

    const refreshed = await auth.refreshNewToken(session);

    expect(refreshed).toBe(session);
    expect(refreshed.accessToken).toBe('newAccessToken');
    expect(refreshed.hasValidToken()).toBe(true);
  });

  test('should throw AuthenticationError for invalid login', async () => {
    const mockErrorResponse = {
      response: {
        data: {
          error: {
            code: 'MS.001.03',
            message: 'Account already registered.',
          },
        },
      },
    };
    const mockPreLoginResponse = {
      signature: 'mockSignature',
      tStamp: 'mockTimestamp',
      encrypted_pw: 'mockEncryptedPassword',
    };
    const requestClient = require('./request').requestClient;
    jest.spyOn(requestClient, 'post')
      .mockResolvedValueOnce({ data: mockPreLoginResponse }) // Mock preLogin response
      .mockRejectedValueOnce(mockErrorResponse);

    await expect(auth.loginStep2('testUser', 'mockEncryptedPassword')).rejects.toThrow(AuthenticationError);
  });

  test('should wrap login request failures without response data', async () => {
    const mockPreLoginResponse = {
      signature: 'mockSignature',
      tStamp: 'mockTimestamp',
      encrypted_pw: 'mockEncryptedPassword',
    };
    const requestClient = require('./request').requestClient;
    jest.spyOn(requestClient, 'post')
      .mockResolvedValueOnce({ data: mockPreLoginResponse })
      .mockRejectedValueOnce(new Error('Network down'));

    const promise = auth.loginStep2('testUser', 'mockEncryptedPassword');

    await expect(promise).rejects.toThrow(AuthenticationError);
    await expect(promise).rejects.toThrow('Network down');
  });

  test('should keep pre-login context when pre-login fails', async () => {
    const requestClient = require('./request').requestClient;
    jest.spyOn(requestClient, 'post')
      .mockRejectedValueOnce(new Error('Socket closed'));

    const promise = auth.loginStep2('testUser', 'mockEncryptedPassword');

    await expect(promise).rejects.toThrow(AuthenticationError);
    await expect(promise).rejects.toThrow('LG pre-login failed');
  });

});
