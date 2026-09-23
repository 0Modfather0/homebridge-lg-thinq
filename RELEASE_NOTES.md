# Homebridge LG ThinQ Connect 2.2.1

> **Experimental, limited testing, and use at your own risk.** Compatibility varies by appliance model, firmware, region, Homebridge version, and operating system. Back up first and keep the 2.1.2 rollback path available. This project is not endorsed by LG, Apple, or Homebridge.

This documentation-only patch corrects the description of how washers, dryers, and WashTowers appear in Apple Home. They are faucet tiles showing On/Off for appliance power. The plugin updates additional HomeKit characteristics for in-use state, remaining duration, and faults, but Apple Home does not present a detailed appliance view. Tapping the tile does not control the appliance. Runtime code and dependencies are unchanged from 2.2.0.

Televisions are not supported because the ThinQ Connect API does not expose them. See `README.md` and `MIGRATION.md` for setup, platform-specific secret storage, rotation, safe reporting, and rollback.
