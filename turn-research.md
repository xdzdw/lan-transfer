# TURN Server Research

## Open Relay Project (openrelay.metered.ca)
- Original credentials: username="openrelayproject", credential="openrelayproject"
- URL: turn:openrelay.metered.ca:80
- Note from 2023 comment: "to prevent abuse you need to create an account to use the TURN server now"
- Static auth URL: staticauth.openrelay.metered.ca with secret "openrelayprojectsecret"

## Current status
The old public credentials (openrelayproject/openrelayproject) may no longer work.
The newer API-based approach requires signup at metered.ca.
The "a.relay.metered.ca" with the credentials I used earlier are from various online examples but may not be valid.

## Best approach
Use the documented static auth credentials that are still publicly documented:
- URL: turn:openrelay.metered.ca:80 (and :443)
- username: openrelayproject
- credential: openrelayproject

Or use staticauth.openrelay.metered.ca with secret for services that support it.
