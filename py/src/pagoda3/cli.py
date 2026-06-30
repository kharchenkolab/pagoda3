"""pagoda3 command line: serve an L* store and open it in the viewer — no notebook needed.

    pagoda3 view sample.lstar.zarr              # serve + open the hosted viewer at the store
    pagoda3 view sample.lstar.zarr --no-open    # serve + just print the URL (e.g. on a remote host)
    pagoda3 serve sample.lstar.zarr             # serve only (Range + CORS); print the store URL

Both keep running until interrupted (Ctrl-C). ``view`` of a ``*.lstar.zarr`` serves it as-is; convert
an external object first (``lstar convert x.h5ad x.lstar.zarr``) or use the Python API
``pagoda3.view(adata)`` to convert in memory.
"""
import argparse
import time

from .launch import DEFAULT_VIEWER, view
from .serve import serve_dir


def main(argv=None):
    p = argparse.ArgumentParser(prog="pagoda3",
                                description="serve an L* store and open it in the pagoda3 viewer")
    sub = p.add_subparsers(dest="cmd", required=True)

    v = sub.add_parser("view", help="serve a *.lstar.zarr and open the viewer at it")
    v.add_argument("store", help="path to a *.lstar.zarr store")
    v.add_argument("--viewer", default=None,
                   help="viewer base URL (default $PAGODA3_VIEWER or %s)" % DEFAULT_VIEWER)
    v.add_argument("--port", type=int, default=0, help="store-server port (default: a free port)")
    v.add_argument("--host", default="127.0.0.1", help="store-server bind host")
    v.add_argument("--no-open", action="store_true", help="do not open a browser; just print the URL")
    mode = v.add_mutually_exclusive_group()
    mode.add_argument("--local", dest="local", action="store_true", default=None,
                      help="serve the bundled viewer same-origin (no CORS/host; default if available)")
    mode.add_argument("--hosted", dest="local", action="store_false",
                      help="use the hosted viewer instead of the local bundle")

    s = sub.add_parser("serve", help="serve a *.lstar.zarr (Range + CORS) and print its URL")
    s.add_argument("store", help="path to a *.lstar.zarr store")
    s.add_argument("--port", type=int, default=0)
    s.add_argument("--host", default="127.0.0.1")

    pub = sub.add_parser("publish", help="package a self-contained, shareable static folder")
    pub.add_argument("store", help="path to a *.lstar.zarr store")
    pub.add_argument("to", nargs="?", default="./share", help="output directory (default ./share)")
    pub.add_argument("--data-only", dest="bundle", action="store_false",
                     help="write only the store (no viewer bundle); host it + point a viewer at it")

    pk = sub.add_parser("pack", help="pack a store into one *.lstar.zarr.zip to drag into the viewer")
    pk.add_argument("store", help="path to a *.lstar.zarr store")
    pk.add_argument("out", nargs="?", default=None, help="output .zip (default <store>.zip)")

    args = p.parse_args(argv)
    if args.cmd == "view":
        view(args.store, local=args.local, viewer=args.viewer, host=args.host, port=args.port,
             open_browser=not args.no_open, block=True)
    elif args.cmd == "serve":
        h = serve_dir(args.store, host=args.host, port=args.port)
        print("pagoda3 serving %s at %s (Ctrl-C to stop)" % (args.store, h.url()))
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            h.stop()
    elif args.cmd == "publish":
        from .publish import publish
        publish(args.store, to=args.to, bundle=args.bundle)
    elif args.cmd == "pack":
        from .publish import pack
        pack(args.store, out=args.out)


if __name__ == "__main__":
    main()
