use std::net::{IpAddr, Ipv6Addr, SocketAddr};

use axum::{
    extract::ConnectInfo,
    http::{HeaderMap, HeaderName, Request},
};

use super::AppConfig;

/// Who a rate-limit bucket belongs to. A request whose IP cannot be determined
/// shares one `Unknown` bucket rather than escaping the limit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum ClientKey {
    Ip(IpAddr),
    Unknown,
}

/// Where the client IP comes from: the socket peer, or one header set by a
/// proxy we trust to overwrite it.
#[derive(Clone)]
pub(crate) struct ClientIpSource {
    trusted_header: Option<HeaderName>,
}

impl ClientIpSource {
    pub(crate) fn from_config(config: &AppConfig) -> Self {
        Self {
            trusted_header: config
                .trust_proxy_headers
                .then(|| config.client_ip_header.clone()),
        }
    }

    pub(crate) fn key(&self, headers: &HeaderMap, peer: Option<SocketAddr>) -> ClientKey {
        let ip = match &self.trusted_header {
            // Behind a proxy the peer is the proxy itself, so a missing or
            // malformed header must not fall back to it.
            Some(name) => headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.trim().parse::<IpAddr>().ok()),
            None => peer.map(|peer| peer.ip()),
        };

        ip.map_or(ClientKey::Unknown, |ip| ClientKey::Ip(normalize(ip)))
    }
}

pub(crate) fn peer_address<B>(request: &Request<B>) -> Option<SocketAddr> {
    request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|peer| peer.0)
}

/// IPv4-mapped IPv6 addresses count as IPv4, and one client usually owns a
/// whole IPv6 /64, so those share a bucket.
fn normalize(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V4(_) => ip,
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => {
                let [a, b, c, d, ..] = v6.segments();
                IpAddr::V6(Ipv6Addr::new(a, b, c, d, 0, 0, 0, 0))
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderMap, HeaderName, HeaderValue};

    use super::{ClientIpSource, ClientKey};

    fn source(trusted: bool) -> ClientIpSource {
        ClientIpSource {
            trusted_header: trusted.then(|| HeaderName::from_static("x-real-ip")),
        }
    }

    fn headers(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-real-ip", HeaderValue::from_str(value).unwrap());
        headers
    }

    fn peer(value: &str) -> Option<std::net::SocketAddr> {
        Some(format!("{value}:4000").parse().unwrap())
    }

    fn ip(value: &str) -> ClientKey {
        ClientKey::Ip(value.parse().unwrap())
    }

    #[test]
    fn forged_header_is_ignored_when_proxy_headers_are_not_trusted() {
        let key = source(false).key(&headers("1.2.3.4"), peer("9.9.9.9"));

        assert_eq!(key, ip("9.9.9.9"));
    }

    #[test]
    fn trusted_header_wins_over_the_peer() {
        let key = source(true).key(&headers("1.2.3.4"), peer("9.9.9.9"));

        assert_eq!(key, ip("1.2.3.4"));
    }

    #[test]
    fn missing_or_malformed_trusted_header_does_not_fall_back_to_the_proxy() {
        assert_eq!(
            source(true).key(&HeaderMap::new(), peer("9.9.9.9")),
            ClientKey::Unknown
        );
        assert_eq!(
            source(true).key(&headers("not an ip"), peer("9.9.9.9")),
            ClientKey::Unknown
        );
    }

    #[test]
    fn missing_peer_shares_the_unknown_bucket() {
        assert_eq!(
            source(false).key(&HeaderMap::new(), None),
            ClientKey::Unknown
        );
    }

    #[test]
    fn ipv6_addresses_in_one_64_share_a_key() {
        let first = source(true).key(&headers("2001:db8:1:2:aaaa::1"), None);
        let second = source(true).key(&headers("2001:db8:1:2:bbbb::2"), None);
        let other = source(true).key(&headers("2001:db8:1:3::1"), None);

        assert_eq!(first, second);
        assert_ne!(first, other);
    }

    #[test]
    fn ipv4_mapped_ipv6_counts_as_ipv4() {
        let key = source(true).key(&headers("::ffff:1.2.3.4"), None);

        assert_eq!(key, ip("1.2.3.4"));
    }
}
