<p align="center">
<img src="https://raw.githubusercontent.com/homebridge/branding/latest/logos/homebridge-wordmark-logo-vertical.png" width="150">
</p>

# Homebridge LG ThinQ

[![npm](https://img.shields.io/npm/v/%400modfather0%2Fhomebridge-lg-thinq/latest?label=latest)](https://www.npmjs.com/package/@0modfather0/homebridge-lg-thinq)
[![npm](https://img.shields.io/npm/dt/%400modfather0%2Fhomebridge-lg-thinq)](https://www.npmjs.com/package/@0modfather0/homebridge-lg-thinq)
[![join-discord](https://badgen.net/badge/icon/discord?icon=discord&label=homebridge-lg-thinq)](https://discord.gg/wEfQpCDtS7)

## Overview

Homebridge LG ThinQ is a Homebridge platform plugin for controlling and monitoring LG ThinQ appliances.

This plugin is not an official LG API client. It works with LG ThinQ account data and supports most current ThinQ2 devices, with optional support for some legacy ThinQ1 devices.

This fork includes the bvksound pre-login fix and the current LG account sign-in flow adapted from [mp-consulting/homebridge-lg-thinq](https://github.com/mp-consulting/homebridge-lg-thinq). It is independently maintained and is not currently a Homebridge Verified Plugin.

## Requirements

* Homebridge `^1.11.2` or Homebridge `^2.0.0`
* Node.js `^22.13.0` or `^24.0.0`

## Installation

Install the plugin from the Homebridge UI, or install it manually:

```sh
npm install -g @0modfather0/homebridge-lg-thinq
```

## Configuration

The Homebridge UI plugin settings are recommended.

1. Open Homebridge UI.
2. Go to the Plugins page.
3. Open the settings for Homebridge LG ThinQ.
4. Select the country and language for your LG account.
5. Sign in with your LG account to get a refresh token.
6. Click the Homebridge UI Save button.
7. Restart Homebridge or the plugin child bridge.
8. Reopen the plugin settings to review discovered devices and device options.

If no devices are listed in the plugin config, all supported devices in the LG account are enabled. Add device entries only when you want to rename devices, configure device options, or enable only specific devices.

## Manual Configuration

Manual editing is supported, but the Homebridge UI is recommended.

```json
{
  "platform": "LGThinQ",
  "auth_mode": "token",
  "refresh_token": "refresh-token-from-lg-login",
  "country": "US",
  "language": "en-US",
  "devices": []
}
```

To enable or configure only specific devices, list them by device id:

```json
{
  "platform": "LGThinQ",
  "auth_mode": "token",
  "refresh_token": "refresh-token-from-lg-login",
  "country": "US",
  "language": "en-US",
  "devices": [
    {
      "id": "device-id",
      "name": "Laundry Room Washer"
    }
  ]
}
```

| Option | Required | Description |
| --- | --- | --- |
| `platform` | Yes | Must be `LGThinQ`. |
| `auth_mode` | Yes | Use `token` for refresh-token auth. `account` is also accepted for username/password config. |
| `refresh_token` | Yes, for token auth | Refresh token returned by the LG login flow. |
| `username` | Yes, for account auth | LG ThinQ account username. |
| `password` | Yes, for account auth | LG ThinQ account password. |
| `country` | Yes | LG account country alpha-2 code, for example `US`. |
| `language` | Yes | LG account language code, for example `en-US`. |
| `devices` | No | Empty or omitted enables all supported discovered devices. |
| `thinq1` | No | Advanced legacy option. Set to `true` manually to enable ThinQ1 devices. |

Device type is detected from LG discovery data. Device-specific settings appear in the Homebridge UI after devices have been discovered.

## Supported Devices

Support depends on the model data returned by LG. If a device appears in the LG ThinQ app but not in Homebridge, open an issue with the device type, model, country, and debug logs.

| Device | Status | Control | ThinQ2 | ThinQ1 |
| --- | --- | --- | --- | --- |
| Refrigerator | Supported | Supported | Yes | Yes |
| Air Purifier | Supported | Supported | Yes | Yes |
| AeroTower | Supported | Supported | Yes | No |
| Washer / Dryer / WashTower | Supported | Limited | Yes | Yes |
| Dishwasher | Supported | No | Yes | No |
| Dehumidifier | Supported | Partial | Yes | No |
| Air Conditioner | Supported | Supported | Yes | Yes |
| Styler | Supported | Limited | Yes | No |
| Range Hood | Supported | Supported | Yes | Yes |
| Oven | Supported | Partial | Yes | No |
| Microwave | Supported | Partial | Yes | No |

## Troubleshooting

Enable Homebridge debug logging when troubleshooting setup or device behavior. Include startup logs, device type/model information, country, language, and the error message when opening an issue.

## CLI Usage

```sh
$ thinq
Usage: thinq [options] [command]

Options:
  -c, --country <type>         Country code for account (default: "US")
  -l, --language <type>        Language code for account (default: "en-US")
  -h, --help                   display help for command

Commands:
  login <username> <password>  Obtain refresh_token from LG account
  auth                         Obtain refresh_token from account logged by Google Account, Apple ID
  help [command]               display help for command
```

## Support

If you have a question about this fork, start a [discussion](https://github.com/0Modfather0/homebridge-lg-thinq/discussions/new). For broader upstream discussion, visit the [original project](https://github.com/nVuln/homebridge-lg-thinq).

If you would like to report a bug in this fork, open an [issue](https://github.com/0Modfather0/homebridge-lg-thinq/issues/new/choose).

## Contributors

Special thanks to [carlosgamezvillegas](https://github.com/carlosgamezvillegas) for implementing Oven and Microwave device support. More detail in [#87](https://github.com/nVuln/homebridge-lg-thinq/issues/87).
