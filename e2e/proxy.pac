function FindProxyForURL(url, host) {
    // Only route NAT network (container IPs) through SOCKS proxy
    if (isInNet(host, "10.0.0.0", "255.255.255.0")) {
        return "SOCKS5 localhost:1080";
    }
    // Everything else goes direct (no proxy)
    return "DIRECT";
}
