#!/usr/bin/env python3
"""Explicit, inspectable non-audio/non-color Resolve maintenance commands."""
import argparse
import importlib.util
import json
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1] / 'vendor/resolve-color-host'
sys.path.insert(0, str(BACKEND))
from resolve_edit_tools import ATTRIBUTES, execute


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    commands.add_parser('capabilities', help='Read installed version/documented capabilities without accessing a project')
    for action in ('inspect', 'frame', 'fades', 'transition', 'copy-video-attributes'):
        sub = commands.add_parser(action)
        sub.add_argument('--project', dest='resolveProjectName', required=True)
        sub.add_argument('--timeline', dest='timelineName', required=True)
        sub.add_argument('--timeline-id', dest='timelineId', required=action not in ('inspect', 'frame'))
        if action == 'frame':
            sub.add_argument('--frame', dest='frameOffset', type=int, required=True, help='Zero-based offset from timeline start')
            sub.add_argument('--output', dest='outputPath', help='New image file; omitted returns base64 JSON')
            sub.add_argument('--format', choices=('png', 'jpg'), default='png')
            sub.add_argument('--max-dimension', dest='maxDimension', type=int, default=1280)
        elif action != 'inspect':
            sub.add_argument('--item-id', dest='itemIds', action='append', required=True)
            sub.add_argument('--apply', action='store_true', help='Apply the explicit targets; default only prints a plan')
            if action == 'fades':
                sub.add_argument('--fade-in', dest='FadeIn', type=int, required=True)
                sub.add_argument('--fade-out', dest='FadeOut', type=int, required=True)
            elif action == 'transition':
                sub.add_argument('--position', choices=('start', 'end'), required=True)
                sub.add_argument('--duration', type=int, required=True, help='Cross Dissolve duration in frames, inside the clip edge')
            else:
                sub.add_argument('--source-id', dest='sourceId', required=True)
                sub.add_argument('--attribute', dest='attributes', action='append', choices=sorted(ATTRIBUTES), required=True)
    args = vars(parser.parse_args())
    spec = importlib.util.spec_from_file_location('kairos_resolve_host', BACKEND / 'resolve-color-host.py')
    host = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(host)
    host.configure_stdio()
    try:
        result = execute(host, host.load_resolve(), args)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except host.HostError as error:
        print(json.dumps(error.to_payload(), ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
