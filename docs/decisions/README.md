# Decisions

The [architecture documents](../architecture.md) describe how the system works
today. A record here exists only for a constraint or a reason that the code
cannot show.

A record states what is true now. When the code changes, edit the record to
match, and delete it when it stops being useful. The list is numbered without
gaps: when a record is deleted, the later ones move up and their references
change with them.

- [ADR-0001: Provider credentials stay on the server; Hub keys identify users](0001-provider-oauth-and-user-scoped-gateway.md)
- [ADR-0002: Call Live exists only where a native call transport is verified](0002-playground-native-voice.md)
- [ADR-0003: A refused generation decides AGY account verification](0003-recoverable-agy-account-verification.md)
