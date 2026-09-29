# SPDX-License-Identifier: Apache-2.0
"""Deterministic Moscow interval model, not an operator's published timetable.

Every station uses the same phase: first boarding at 05:30, no boarding from
01:00 until 05:30. A train already boarded may finish its ride after closure.
The Core copy is byte-checked in tests so offline and service quotes agree.
"""

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

TIMETABLE_VERSION = "moscow-intervals-v1-0530-0100-600-90-180-90-300-600"
_ZONE = ZoneInfo("Europe/Moscow")
_BANDS = ((330, 450, 600), (450, 600, 90), (600, 1020, 180),
          (1020, 1200, 90), (1200, 1380, 300), (1380, 1500, 600))


def next_departure(epoch: int) -> int | None:
    """Return the next boarding Unix second, or None during closure/no last train.

    A passenger ready exactly at a departure boards it. Band boundaries reset
    the headway phase; all supplied bands align with their preceding phase.
    Overnight waiting for the following service day is deliberately excluded.
    """
    local = datetime.fromtimestamp(epoch, _ZONE)
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
    if local.hour < 5 or (local.hour == 5 and local.minute < 30):
        midnight -= timedelta(days=1)
    seconds = epoch - int(midnight.timestamp())
    for start, end, headway in _BANDS:
        if start * 60 <= seconds < end * 60:
            elapsed = seconds - start * 60
            boarding = start * 60 + ((elapsed + headway - 1) // headway) * headway
            if boarding >= 1500 * 60:
                return None
            return int(midnight.timestamp()) + boarding
    return None
