# MeshCentral MCP endpoint

MeshCentral serves a Model Context Protocol (MCP) endpoint at `/mcp` on its
existing HTTPS listener. It is always on while the server runs; every request
must carry a login-token credential, and the token's account is the capability
boundary.

The endpoint exposes the same tools as the stdio bridge — the full command
catalogue plus desktop capture and control — so an MCP client anywhere that can
reach the server can use it with no local installation.

## Get a credential

1. Sign in to the web UI and open **My Account**.
2. Under **Active Login Tokens**, choose **New**, give the token a name and an
   expiry.
3. The dialog shows the username and password once and a single copyable
   connection token (`mt_…`). Copy it then; the password is hashed and can
   never be shown again.
4. To rotate a token, create a new one and remove the old one.

## Configure an MCP client

Add a remote MCP server entry:

```jsonc
{
  "mcp": {
    "meshcentral": {
      "type": "remote",
      "url": "https://meshcentral.example.com/mcp",
      "headers": {
        "Authorization": "Bearer mt_<your connection token>"
      },
      "enabled": true
    }
  }
}
```

## Credential format

A connection token is `mt_` followed by the base64url encoding of
`tokenUser:tokenPass`. It is produced by the account page when a token is
created; the endpoint decodes it, verifies the password in the same way as a
password login, checks the expiry, and maps the request to the owning account.

## stdio bridge

The stdio bridge remains available for local use:

```
node mcp-server.js --url wss://meshcentral.example.com:443 --loginuser admin --loginpass ...
```

Flags and `MESHCENTRAL_*` environment variables are documented with
`node mcp-server.js --help`.
