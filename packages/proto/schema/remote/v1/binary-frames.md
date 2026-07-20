# kmux remote binary frames v1

All integers use network byte order. Every frame starts with `uint32 frameLength`
followed by `uint8 frameKind` and `frameLength - 1` payload bytes. A receiver
rejects zero length, unknown kinds, truncated frames, and frames over 1 MiB
before allocating the advertised payload.

| Kind | Payload                                               | Hard maximum |
| ---: | ----------------------------------------------------- | -----------: |
|    1 | UTF-8 control JSON validated by `control.schema.json` |      256 KiB |
|    2 | binary terminal message                               |      256 KiB |
|    3 | offset-checked checkpoint bytes                       |      256 KiB |
|    4 | offset-checked metadata bytes                         |      256 KiB |
|    5 | bounded stream completion/error JSON                  |      256 KiB |

Terminal message subtypes are `1 output`, `2 resize mutation`, `3 exit`,
`16 input`, and `17 resize request`. Mutation messages carry an unsigned
64-bit sequence. Input carries two uint16-length-prefixed UTF-8 identifiers,
an unsigned 64-bit input sequence, and raw bytes. No terminal payload is
base64-encoded or represented through a JavaScript number.
