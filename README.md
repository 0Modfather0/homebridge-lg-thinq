# Homebridge LG ThinQ Connect

> [!CAUTION]
> **Experimental — limited real-world testing — use at your own risk.** The ThinQ Connect backend has not been broadly validated across LG models, firmware, regions, Homebridge releases, or operating systems. Preserve backups and understand the rollback procedure before installing. This independent project is not endorsed, certified, supported, or affiliated with LG, Apple, or Homebridge.

Read-only Homebridge integration for LG washers, dryers, and WashTowers using LG's official ThinQ Connect API. Version 2.2.0 retains the deprecated legacy backend for explicit compatibility use; it never falls back to legacy authentication automatically.

The npm package remains `@0modfather0/homebridge-lg-thinq` and the Homebridge platform name remains `LGThinQ`, preserving upgrades and cached accessory identity.

## Supported devices

| ThinQ Connect device | Status | Current HomeKit presentation |
| --- | --- | --- |
| Washer | Experimental | Running/power state, remaining time, fault, optional completion/door/tub-clean services |
| Dryer | Experimental | Running/power state, remaining time, fault, optional completion/door services |
| WashTower | Experimental | Model-dependent washer/dryer state through the existing appliance accessory |
| Television | Unsupported | ThinQ Connect does not expose televisions |
| Other ThinQ appliances | Unsupported by the official backend in 2.2.0 | Use the explicitly selected deprecated legacy backend if required |

The official backend is deliberately read-only. It does not provide remote start, cycle selection, or other consequential controls. “Experimental” means automated tests and a limited deployment validation are performed, but broad public hardware compatibility has not been established.

## Before installing

1. Back up the Homebridge configuration, persistence, and accessories cache.
2. Record the installed version: `npm list -g @0modfather0/homebridge-lg-thinq`.
3. Keep or download the known-good 2.1.2 package for rollback.
4. Create a ThinQ Connect personal access token (PAT) for the main account that owns the appliances. Grant only the device read, state read, event/MQTT subscription, route, and client-certificate permissions required by ThinQ Connect.
5. Store the PAT in a password manager until submitting it through the plugin interface.

To roll back immediately, stop Homebridge, install `@0modfather0/homebridge-lg-thinq@2.1.2`, restore the pre-migration configuration/data if needed, and start Homebridge. Do not delete cached accessories during rollback.

## Installation and migration

Install through Homebridge UI or manually:

```shell
npm install -g @0modfather0/homebridge-lg-thinq@2.2.0
```

Open the plugin settings, select **ThinQ Connect official API (Experimental)**, choose the account country and language, and submit the PAT in the dedicated credential panel. The server validates the candidate before atomically replacing a previously valid credential. The PAT is never added to `config.json` and is never returned to the browser after submission.

Select **Discover experimental appliances**, review the matches, then save and restart Homebridge. Migration matching proceeds by official API device ID, then unique serial number, then a unique name/type match. An ambiguous match aborts; it does not guess. Existing configured accessory IDs are retained to preserve HomeKit pairing and automations.

After migration, verify every appliance is present only once, its state and remaining time update during a real cycle, completion events behave as expected, and the logs contain no credentials. Revoke the PAT and roll back to 2.1.2 if continuity or reporting fails.

## How the official backend works

The plugin uses the pinned `thinqconnect` TypeScript SDK version `0.9.10-beta`. It subscribes to supported appliance events over MQTT and reconciles state every five minutes. A stable client UUID and issued MQTT private key/certificate are kept in protected Homebridge plugin storage. Quota responses use bounded, jittered exponential backoff and a supplied retry interval when the SDK response exposes one.

PAT scopes and rate limits are controlled by LG and may change. Use the least-privilege scopes shown by the ThinQ Connect portal, avoid very short polling intervals, and consult the portal for the current quota assigned to the token.

## Credential storage

Resolution order:

1. `LG_THINQ_PAT_FILE` — existing, read-only external secret file. Replacement and removal are disabled in the UI.
2. `LG_THINQ_SECRET_DIR` — writable directory managed by this plugin; the PAT is stored as `pat`.
3. `.lg-thinq-connect/pat` beneath the Homebridge storage path.

On Linux and macOS, managed directories use mode `0700` and files use `0600`, owned by the Homebridge runtime user. macOS normally resolves beneath `~/.homebridge`. On Windows, the default is beneath `%HOMEPATH%\.homebridge`; drive-letter and UNC environment paths are supported, and files inherit the Homebridge service identity's NTFS permissions. POSIX `chmod` does not enforce Windows ACLs. Administrators may restrict a managed directory with:

```powershell
icacls "C:\path\to\secrets" /inheritance:r /grant:r "HOME_BRIDGE_SERVICE_ACCOUNT:(OI)(CI)F" /grant:r "SYSTEM:(OI)(CI)F"
```

Replace the placeholder with the actual Windows service identity and validate access before restarting. The plugin retries briefly when antivirus software temporarily locks a managed file.

Filesystem permissions are **not encryption**. An administrator/root user, the Homebridge service identity, host compromise, or an unencrypted disk can still expose the PAT. Native Keychain, DPAPI/Credential Manager, TPM-backed storage, and application-level encryption are outside this release.

### Docker

Mount a dedicated secret directory read/write and keep it outside Homebridge application data, source control, telemetry, and routine backups:

```yaml
services:
  homebridge:
    environment:
      LG_THINQ_SECRET_DIR: /run/homebridge-secrets
    volumes:
      - /srv/apps/homebridge/secrets:/run/homebridge-secrets
```

On Linux, create the host directory for the container's Homebridge UID and mode `0700`; the managed `pat` file is mode `0600`. Do not bake the PAT into an image, Compose manifest, environment variable, or Git repository.

### Linux and macOS without Docker

Use the default Homebridge storage location or set `LG_THINQ_SECRET_DIR` in the Homebridge service environment. Ensure the Homebridge runtime account—not an interactive administrator account—owns the directory. For an external secret provider, mount or create a mode-`0600` file and set `LG_THINQ_PAT_FILE`.

### Windows without Docker

Run Homebridge under a dedicated service identity, set either environment variable at the service level, and grant that identity read/write access only to the managed directory. If `LG_THINQ_PAT_FILE` is set, grant read access and manage rotation outside the plugin. UNC paths require the service identity to have network-share and NTFS permissions.

### External secret mode

`LG_THINQ_PAT_FILE` is treated as externally managed and read-only. Rotate it atomically in the external secret system and restart Homebridge. The plugin interface reports only configuration status and location; it never returns file contents.

## Rotation and revocation

For managed storage, submit a new PAT in the interface. The candidate is validated first, writes are serialized, and an atomic replacement preserves the previous PAT if validation or writing fails. Restart Homebridge and validate state updates, then revoke the old PAT in LG's portal. For external mode, rotate at the source and restart. A revoked or missing PAT causes the official backend to fail explicitly; it does not fall back to legacy authentication.

## Legacy compatibility mode

Legacy LG account and refresh-token modes are deprecated. They remain selectable for device families not supported by the official backend. Legacy credentials may still reside in `config.json`; migrate away where practical. Selecting ThinQ Connect clears legacy credentials from the UI model, but you should independently inspect backups and configuration history.

## Safe issue reporting

Use the bug-report template and state the appliance category, model, region, Homebridge/Node/plugin versions, host OS, and whether Docker is used. Never post a PAT, refresh token, MQTT private key/certificate, client UUID, complete device ID, serial number, email address, IP address, HomeKit code, or raw unreviewed logs. Revoke any credential accidentally disclosed.

## Development

Supported runtimes are Node 22 and 24 with Homebridge 1.11.2 or 2.x. CI compiles, lints, tests, audits production dependencies, and dry-runs the package on Ubuntu, macOS, and Windows. Official API tests use sanitized fixtures only.

```shell
npm ci
npm run check
npm pack --dry-run
```

## License and attribution

Apache-2.0. This fork builds on work by nVuln, bvksound, mp-consulting, and prior contributors. The official API adapter uses LG's Apache-2.0 `thinqconnect` package; LG trademarks belong to LG Electronics.
