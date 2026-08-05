"""Raw MCP client: speaks the protocol by hand over stdio.

No SDK on the client side — we write the JSON-RPC lines ourselves to show
the wire format (initialize -> tools/list -> tools/call). The server is the
real FastMCP server, so this proves a hand-rolled client interoperates with
an SDK server.

Usage:
    python mcp_raw_client.py
"""
import json
import os
import subprocess
import sys
from mcp.types import LATEST_PROTOCOL_VERSION

BACKEND = os.path.dirname(os.path.abspath(__file__))


def main() -> None:
    proc = subprocess.Popen(
        [sys.executable, os.path.join(BACKEND, "mcp_server.py")],
        cwd=BACKEND,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    assert proc.stdin is not None and proc.stdout is not None
    stdin = proc.stdin
    stdout = proc.stdout
    next_id = 1

    def rpc(method: str, params: dict) -> None:
        """Send one JSON-RPC line; read lines until our id comes back."""
        nonlocal next_id
        msg_id = next_id
        next_id += 1
        frame = {"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params}
        stdin.write(json.dumps(frame) + "\n")
        stdin.flush()
        print(f"\n--> {method}")
        while True:
            line = stdout.readline()
            if not line:
                print("(server closed stdout)")
                return
            reply = json.loads(line)
            print(f"<-- {json.dumps(reply, indent=2)}")
            if reply.get("id") == msg_id:
                return

    def notify(method: str) -> None:
        """Fire-and-forget: no id, no response expected."""
        frame = {"jsonrpc": "2.0", "method": method}
        stdin.write(json.dumps(frame) + "\n")
        stdin.flush()
        print(f"\n--> {method} (notification, no reply)")

    rpc("initialize", {
        "protocolVersion": LATEST_PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": {"name": "raw-client", "version": "0.1"},
    })
    notify("notifications/initialized")
    rpc("tools/list", {})
    rpc("tools/call", {
        "name": "check_stock",
        "arguments": {"sku": "21212"},
    })
    stdin.close()
    proc.terminate()


if __name__ == "__main__":
    main()
