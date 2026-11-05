# Known issues to investigate

## Podman CNI warning on container startup

Reported after restarting with the automatic post-install prompt changes:

```text
pis: [58.3s] Starting container (first start after a build can take longer)…
WARN[0000] Error validating CNI config file /home/mattias/.config/cni/net.d/draftv2-net-20260304160857.conflist: [failed to find plugin "dnsname" in path [/usr/local/libexec/cni /usr/libexec/cni /usr/local/lib/cni /usr/lib/cni /opt/cni/bin]]
```

Not diagnosed or fixed yet. The warning is emitted by Podman's CNI network configuration validation, before Pi starts; it is not itself evidence that the automatic user prompt is broken. Check whether the container actually fails or starts despite the warning.

Investigate the named network, the installed CNI plugin paths, Podman's network backend and any other containers/projects using this network. Do not remove or rewrite existing network configuration without checking its users. The `draftv2` network may be unrelated to pis, which does not explicitly select it.
