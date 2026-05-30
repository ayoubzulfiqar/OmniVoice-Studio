import socket
from unittest.mock import patch
from services import network_share as ns


def _addr(ip):
    class A:  # mimic psutil snicaddr
        family = socket.AF_INET
        address = ip
    return A()


def test_lan_ipv4_filters_loopback_and_linklocal():
    fake = {
        "lo0": [_addr("127.0.0.1")],
        "en0": [_addr("192.168.1.42")],
        "en1": [_addr("169.254.5.5"), _addr("10.0.0.9")],
    }
    with patch("services.network_share.psutil.net_if_addrs", return_value=fake):
        out = ns.lan_ipv4_addresses()
    assert out == ["192.168.1.42", "10.0.0.9"]


def test_gen_pin_is_six_digits():
    pin = ns._gen_pin()
    assert pin.isdigit() and len(pin) == 6
