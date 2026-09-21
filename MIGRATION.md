# ThinQ Connect 2.2.0 migration and rollback

> **Experimental and use at your own risk.** This backend has limited real-world testing. Back up Homebridge before proceeding.

1. Back up Homebridge's configuration, persistence, and cached accessories without copying the PAT.
2. Record the 2.1.2 configuration and package version.
3. Install the exact 2.2.0 tarball or npm package.
4. Configure `LG_THINQ_SECRET_DIR` or read-only `LG_THINQ_PAT_FILE`; otherwise the platform-specific Homebridge storage default is used.
5. Select `thinq_connect`, submit the PAT through the plugin interface, and discover devices.
6. Review API ID/serial matches. An ambiguous migration must be corrected manually; never delete the old accessory to work around it.
7. Restart and verify accessory continuity, current state, remaining time, completion events, MQTT updates, and five-minute reconciliation.
8. Inspect configuration, logs, Git, backups, and package contents for credential leakage.

To roll back, stop Homebridge, install `@0modfather0/homebridge-lg-thinq@2.1.2`, restore the pre-migration configuration/data snapshot if necessary, and restart. Preserve cached accessories. Revoke the ThinQ Connect PAT after rollback if it is no longer required.
