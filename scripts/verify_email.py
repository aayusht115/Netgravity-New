"""
NetGravity — Is email actually being delivered?
================================================
Reports what every sender in this application would do with the current
environment, and optionally sends one real message to prove it.

    python scripts/verify_email.py              # free, no mail sent
    python scripts/verify_email.py --live you@example.com

WHY THIS EXISTS
---------------
Email fails quietly here in a specific way: with no SMTP host configured the
missing-data sender runs in STUB MODE, logs "[EMAIL STUB] would have
emailed ...", and returns `sent=True`. A caller that checks only `.sent`
reports success for a message that never left the machine.

So "did it send?" is not answerable by reading the code or the logs casually.
This answers it in one command, and names the variable to set when the answer
is no.

TWO SENDERS, ONE MAILBOX
------------------------
`netgravity/action_agent/` sends the missing-data requests.
`app/backend/services/notifications.py` sends password-reset links.

They were written separately and named the same settings differently
(_USERNAME vs _USER, _FROM_ADDRESS vs _FROM, _USE_TLS vs _STARTTLS). Both now
accept both spellings, and this script checks both so a half-configured mailbox
cannot look complete.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

REQUIRED = [
    ("NETGRAVITY_SMTP_HOST", ("NETGRAVITY_SMTP_HOST",), "smtp.gmail.com"),
    ("SMTP port", ("NETGRAVITY_SMTP_PORT",), "587"),
    ("username", ("NETGRAVITY_SMTP_USERNAME", "NETGRAVITY_SMTP_USER"),
     "you@yourcompany.com"),
    ("password", ("NETGRAVITY_SMTP_PASSWORD",), "an APP password, not your login"),
    ("from address", ("NETGRAVITY_SMTP_FROM_ADDRESS", "NETGRAVITY_SMTP_FROM"),
     "netgravity@yourcompany.com"),
]

OPTIONAL = [
    ("NETGRAVITY_APP_BASE_URL", "links in the email resolve to a real host"),
    ("NETGRAVITY_EMAIL_STRICT", "a failed live send raises instead of silently stubbing"),
    ("NETGRAVITY_DEFAULT_RECIPIENT_EMAIL", "who missing-data requests go to by default"),
]


def _first(*names: str) -> str:
    for name in names:
        value = (os.environ.get(name) or "").strip()
        if value:
            return value
    return ""


def _rule(title: str) -> None:
    print(f"\n{'=' * 66}\n{title}\n{'=' * 66}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", metavar="RECIPIENT",
                        help="send one real test message to this address")
    args = parser.parse_args()

    # Importing the config loads .env, the same way the application does.
    from netgravity.action_agent.config import ActionAgentConfig
    from netgravity.action_agent.email_sender import EmailSender

    config = ActionAgentConfig()
    sender = EmailSender(config)

    _rule("1. SETTINGS")
    missing = []
    for label, names, example in REQUIRED:
        value = _first(*names)
        shown = ("(set)" if "PASSWORD" in names[0] and value
                 else value or "(not set)")
        mark = "ok  " if value else "MISS"
        print(f"  [{mark}] {label:<14} {shown}")
        if not value:
            missing.append((label, names, example))

    print()
    for name, why in OPTIONAL:
        value = (os.environ.get(name) or "").strip()
        print(f"  [    ] {name:<34} {value or '(not set)'}  — {why}")

    _rule("2. WHAT EACH SENDER WOULD DO")
    stub = sender.stub_mode
    print(f"  missing-data emails : {'STUBBED — nothing is sent' if stub else 'LIVE'}")
    print(f"  password-reset mail : "
          f"{'unconfigured — delivery fails' if not _first('NETGRAVITY_SMTP_HOST') else 'LIVE'}")

    if stub:
        print("\n  A stubbed send still returns sent=True and writes")
        print("  '[EMAIL STUB] would have emailed ...' to the log. Nothing leaves")
        print("  this machine. That is why 'it looked fine' is not evidence.")

    if missing:
        _rule("3. WHAT TO SET")
        print("  Add to .env:\n")
        for label, names, example in missing:
            print(f"    {names[0]}={example}")
        print("\n  Gmail: turn on 2-Step Verification, then create an App Password")
        print("  at https://myaccount.google.com/apppasswords — Google rejects")
        print("  ordinary account passwords over SMTP.")
        print("\n  Prefer a dedicated mailbox over a personal one: the From")
        print("  address is visible to every recipient.")
        return 1

    if not args.live:
        _rule("3. LIVE TEST — SKIPPED")
        print("  Every setting is present. To prove delivery end to end:")
        print("    python scripts/verify_email.py --live you@example.com")
        return 0

    _rule("3. SENDING ONE REAL MESSAGE")
    print(f"  to: {args.live}")
    result = sender.send(
        to=[args.live],
        subject="NetGravity — email delivery test",
        body=("This is a test message from scripts/verify_email.py.\n\n"
              "If you are reading it, outbound email is configured correctly "
              "and the missing-data requests will reach their recipients.\n"),
    )
    print(f"  sent    : {result.sent}")
    print(f"  stubbed : {result.stubbed}")
    print(f"  notes   : {result.notes}")
    if getattr(result, "refused", None):
        print(f"  REFUSED : {result.refused}")

    if result.stubbed:
        print("\n  STILL STUBBED despite complete settings — the config this")
        print("  script read is not the one the sender used. Check for a shell")
        print("  variable overriding .env.")
        return 1
    if not result.sent:
        print("\n  The send failed. The note above carries the server's reason.")
        return 1

    print("\n  Delivered to the mail server. Check the inbox (and spam) to")
    print("  confirm it arrived — acceptance by the server is not the same as")
    print("  delivery to a person.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
