"""Mint a short, room-scoped, microphone-only LiveKit access token for the phone.

The phone fetches one of these per session and joins exactly one room. Secrets come
from env (LIVEKIT_API_KEY / LIVEKIT_API_SECRET); the defaults match `livekit-server
--dev` so a dev standup works out of the box. Short TTL + mic-only + single-occupant
room = the WebRTC auth posture from the spec (§7).
"""
import os
from datetime import timedelta

from livekit import api

ROOM = "drive-room"


def mint(identity, room=ROOM, ttl_s=60, api_key=None, api_secret=None):
    """Return a signed JWT: room-scoped join, publish microphone only, ~ttl_s seconds."""
    api_key = api_key or os.environ.get("LIVEKIT_API_KEY", "devkey")
    api_secret = api_secret or os.environ.get("LIVEKIT_API_SECRET", "secret")
    grants = api.VideoGrants(
        room_join=True,
        room=room,
        can_publish=True,
        can_subscribe=True,
        can_publish_sources=["microphone"],
    )
    return (
        api.AccessToken(api_key, api_secret)
        .with_identity(identity)
        .with_ttl(timedelta(seconds=ttl_s))
        .with_grants(grants)
        .to_jwt()
    )


def single_occupant_opts():
    """Room-create option enforcing one participant (the phone); second join rejected."""
    return {"max_participants": 1}
