# Homebridge LG ThinQ Connect 2.2.0

> **Experimental, limited testing, and use at your own risk.** Compatibility varies by appliance model, firmware, region, Homebridge version, and operating system. Back up first and keep the 2.1.2 rollback path available. This project is not endorsed by LG, Apple, or Homebridge.

This release adds a read-only official ThinQ Connect backend for washers, dryers, and WashTowers, using MQTT events plus five-minute reconciliation. It preserves the npm package and Homebridge platform identities, protects the PAT in a separate cross-platform secret file, and keeps the deprecated legacy backend available only when explicitly selected.

Televisions are not supported because the ThinQ Connect API does not expose them. See `README.md` and `MIGRATION.md` for setup, platform-specific secret storage, rotation, safe reporting, and rollback.
