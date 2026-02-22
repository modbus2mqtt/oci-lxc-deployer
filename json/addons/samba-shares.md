## Notice

This addon installs a **hookscript** on the Proxmox host
(`/var/lib/vz/snippets/lxc-oci-deployer-hook.sh`) that automatically
restarts Samba services after a container restart.

The hookscript can be used by other addons as well and will be
registered for the current container being installed.
