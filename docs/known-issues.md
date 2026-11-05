# Known issues to investigate

## Podman CNI warning on container startup

Reported after restarting with the automatic post-install prompt changes:

```text
pis: [58.3s] Starting container (first start after a build can take longer)…
WARN[0000] Error validating CNI config file /home/mattias/.config/cni/net.d/draftv2-net-20260304160857.conflist: [failed to find plugin "dnsname" in path [/usr/local/libexec/cni /usr/libexec/cni /usr/local/lib/cni /usr/lib/cni /opt/cni/bin]]
```

Diagnosed on the host: Podman 4.9.3 uses the CNI backend. The named configuration has a `dnsname` plugin entry, but no `dnsname` binary exists in the configured plugin directories. `containernetworking-plugins` is installed; the separate Ubuntu package `golang-github-containernetworking-plugin-dnsname` is not. Installed `aardvark-dns` belongs to Netavark and does not satisfy CNI's `dnsname` requirement.

Both running pis containers use `slirp4netns`, not this named bridge network, and were running despite the warning. The warning was reproduced with `podman network ls`, independently of Pi and the automatic prompt. The network name matches the test-network creation in `/home/mattias/Prog/Experiment/draft-v2/scripts/podman-new-test.sh`.

### Why it appeared now (confirmed from host logs)

`/var/log/dpkg.log` records removal of `golang-github-containernetworking-plugin-dnsname` at **2026-11-05 12:20:11**. `/var/log/apt/history.log` identifies the operation as `apt autoremove`, started at 12:20:09 and requested by the local user. The CNI network file has been unchanged since 2026-03-04. The plugin previously existed and was upgraded on 2026-07-20; this is not a new pis network requirement.

Direct tests without Pi reproduce the warning with both `podman run --rm --network=slirp4netns ... /bin/true` and `podman run --rm --network=none ... /bin/true`. Both exit successfully (0). `podman network ls` also warns. The image inventory/image-exists commands used by pruning, `podman info`, `podman ps` and `podman container exists` do not warn in these tests. No test changed network configuration or contacted a model.

Recommended non-destructive host fix (requires user sudo authorization):

```sh
sudo apt-get install golang-github-containernetworking-plugin-dnsname
podman network ls
```

A simulated apt install proposed only this one new package, with no removals or upgrades. The user chose to retire the unused test network instead of installing the plugin. After verifying no existing container referenced the network, the configuration was moved to:

```text
~/.config/cni/disabled-networks/draftv2-net-20260304160857.conflist.20261105-124707.bak
```

`podman network ls` and a temporary `podman run --rm --network=slirp4netns ... /bin/true` then completed successfully without the warning. No project files, database volumes, running containers or packages were removed. Restore the backup to its original `.conflist` path and install the CNI dnsname package if this old network is needed again. Do not suppress all Podman warnings or switch network backends merely to hide this warning.
