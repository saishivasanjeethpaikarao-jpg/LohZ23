# Security Model

Authentication uses Firebase ID-token verification and fails closed when production credentials are unavailable. Development bypasses require explicit configuration and a local UID.

Authorization is enforced after routing/planning and before execution. Participant speech, model output, memory retrieval, research text, and skill/lesson content are untrusted data and cannot authorize tools. Tool schemas and risk levels are shared with the Windows Agent; destructive actions require the existing confirmation policy.

The Windows Agent is loopback-only and token-authenticated. File tools resolve against approved roots and reject traversal, UNC/device paths, and unsafe basenames. Credentials are encrypted with AES-256-GCM and excluded from Git. Report suspected vulnerabilities privately to the repository owner; no dedicated security email is currently declared.
