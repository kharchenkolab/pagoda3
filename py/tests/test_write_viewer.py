"""pagoda3.write_viewer: navigator fields are correct, engine-agnostic, and round-trip cleanly."""
import os
import tempfile
import numpy as np
import scipy.sparse as sp
import lstar
import pagoda3


def _toy(nc=120, ng=20, seed=0):
    rng = np.random.default_rng(seed)
    X = sp.csc_matrix(rng.poisson(0.6, (nc, ng)).astype("f4"))
    leiden = np.array(["c%d" % (i % 4) for i in range(nc)])
    ds = lstar.Dataset(kind="sample")
    ds.add_axis("cells", ["cell%d" % i for i in range(nc)], role="observation")
    ds.add_axis("genes", ["g%d" % j for j in range(ng)], role="feature")
    ds.add_field("counts", X, role="measure", span=["cells", "genes"], state="raw")
    ds.add_field("leiden", list(leiden), role="label", span=["cells"])
    ds.add_field("cell_type", ["t%d" % (i % 3) for i in range(nc)], role="label", span=["cells"])
    return ds, X, leiden


def test_fields_stats_and_navigators():
    ds, X, leiden = _toy()
    pagoda3.write_viewer(ds, "leiden", also=["cell_type"])
    assert "viewer@0.1" in ds.profiles
    for f in ["stats_leiden_sum", "markers_leiden_lfc", "markers_cell_type_lfc",
              "od_score", "counts_cellmajor_order", "counts_cellmajor"]:
        assert f in ds.fields, f
    assert "groups_cell_type" in ds.axes and "od_genes" not in ds.axes
    # cluster stats == numpy per-group colSums(log1p)
    Xl = X.copy().astype("f8"); Xl.data = np.log1p(Xl.data); Xlr = Xl.tocsr()
    groups = sorted(set(leiden.tolist())); code = np.array([groups.index(l) for l in leiden])
    S = np.array([np.asarray(Xlr[code == g].sum(0)).ravel() for g in range(len(groups))])
    assert np.max(np.abs(np.asarray(ds.field("stats_leiden_sum").values) - S)) < 1e-4
    # counts_cellmajor is cell-major CSR, PHYSICALLY reordered cluster-contiguous; reading physical
    # row counts_cellmajor_order[cell] recovers that cell's counts (the locality-reorder convention).
    dp = ds.field("counts_cellmajor")
    assert tuple(dp.values.shape) == X.shape and dp.encoding == "csr"
    pos = np.asarray(ds.field("counts_cellmajor_order").values).astype(int)
    assert np.array_equal(np.sort(pos), np.arange(X.shape[0]))            # a valid permutation
    cm = dp.values.tocsr(); Xr = X.tocsr()
    for c in range(X.shape[0]):
        assert np.array_equal(np.asarray(cm.getrow(int(pos[c])).todense()).ravel(),
                              np.asarray(Xr.getrow(c).todense()).ravel())


def test_engine_agnostic_and_no_stale():
    # cluster stats identical on either lstar engine; a corrupted field is corrected on re-run.
    ds_c, _, _ = _toy(seed=2); pagoda3.write_viewer(ds_c, "leiden", engine="c++")
    ds_p, _, _ = _toy(seed=2); pagoda3.write_viewer(ds_p, "leiden", engine="python")
    assert np.abs(np.asarray(ds_c.field("stats_leiden_sum").values)
                  - np.asarray(ds_p.field("stats_leiden_sum").values)).max() < 1e-5
    n = len(ds_c.fields)
    ds_c.field("stats_leiden_sum").values[:] = -999.0
    pagoda3.write_viewer(ds_c, "leiden")
    assert len(ds_c.fields) == n and ds_c.profiles.count("viewer@0.1") == 1
    assert float(np.asarray(ds_c.field("stats_leiden_sum").values).min()) > -900


def test_roundtrip():
    ds, _, _ = _toy(seed=1)
    pagoda3.write_viewer(ds, "leiden")
    assert not [e for e in lstar.validate(ds) if e.startswith("ERROR")]
    p = os.path.join(tempfile.mkdtemp(), "v.lstar.zarr")
    lstar.write(ds, p)
    ds2 = lstar.read(p)
    assert "viewer@0.1" in ds2.profiles
    assert "counts_cellmajor" in ds2.fields and "stats_leiden_sum" in ds2.fields
