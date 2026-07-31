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


# --- numeric partitions (P4) -----------------------------------------------------------------------
# A clustering that arrives as INTEGERS is a `measure` to L*, so lstar's label-role detection skips it.
# On a real Seurat-derived store that meant the one grouping never summarized was `integrated_clusters`
# — the actual clustering — while every categorical annotation got stats. Every cluster-derived category
# (scType output, a hand-merged annotation) then has no summarized base to derive from.

def _numeric_cluster_ds(nc=120, ng=20, nclust=5, seed=3, name="integrated_clusters", dtype="i8"):
    rng = np.random.default_rng(seed)
    X = sp.csc_matrix(rng.poisson(0.6, (nc, ng)).astype("f4"))
    ds = lstar.Dataset(kind="sample")
    ds.add_axis("cells", ["cell%d" % i for i in range(nc)], role="observation")
    ds.add_axis("genes", ["g%d" % j for j in range(ng)], role="feature")
    ds.add_field("counts", X, role="measure", span=["cells", "genes"], state="raw")
    ds.add_field(name, np.arange(nc, dtype=dtype) % nclust,          # the clustering, as NUMBERS
                 role="measure", span=["cells"])
    ds.add_field("celltypist", ["t%d" % (i % 3) for i in range(nc)], # a categorical annotation
                 role="label", span=["cells"])
    ds.add_field("nCount_RNA", np.asarray(X.sum(axis=1)).ravel(),    # a real measure — must NOT be a grouping
                 role="measure", span=["cells"])
    ds.add_field("pct_mito", rng.random(nc) * 0.1, role="measure", span=["cells"])
    return ds


def test_numeric_clustering_gets_summarized():
    ds = _numeric_cluster_ds()
    pagoda3.write_viewer(ds)                                   # no grouping named: the store's own defaults
    for f in ["stats_integrated_clusters_sum", "stats_integrated_clusters_nexpr",
              "markers_integrated_clusters_lfc"]:
        assert f in ds.fields, f
    assert len(ds.axis("groups_integrated_clusters")) == 5


def test_numeric_clustering_does_not_cost_the_annotations_their_stats():
    # the regression this is built to prevent: passing an explicit groupings list to lstar SILENCES its
    # auto-detection, so naming only the clustering would drop celltypist. primary= composes instead.
    ds = _numeric_cluster_ds()
    pagoda3.write_viewer(ds)
    assert "stats_celltypist_sum" in ds.fields
    assert ds.field("counts_cellmajor_order").provenance["group"] == "integrated_clusters", \
        "the clustering should be the reorder key (lstar's primary=)"


def test_real_measures_are_not_mistaken_for_partitions():
    ds = _numeric_cluster_ds()
    names = [n for n, _ in pagoda3.viewer._numeric_partitions(ds)]
    assert names == ["integrated_clusters"]
    pagoda3.write_viewer(ds)
    for bad in ["stats_nCount_RNA_sum", "stats_pct_mito_sum"]:
        assert bad not in ds.fields, bad


def test_partition_detection_edges():
    f = pagoda3.viewer._partition_levels
    assert f(np.arange(50) % 7) == 7                     # 0..6 contiguous codes
    assert f((np.arange(50) % 7).astype("f8")) == 7      # float-typed but integral (h5ad often is)
    assert f(np.arange(50) % 7 + 1) == 7                 # 1-based codes (R factors)
    assert f(np.linspace(0, 1, 50)) is None              # fractional -> a score, not a partition
    assert f(np.zeros(50)) is None                       # constant -> no partition
    assert f(np.arange(500)) is None                     # per-cell unique -> an id, not a clustering
    assert f(np.array([1.0, np.nan, 2.0])) is None       # non-finite -> not codes
    assert f(np.arange(50) % 7, max_card=3) is None      # over the cardinality bound
    # integral + few levels is NOT enough: a shallow-library count measure looks just like codes until
    # you notice its levels don't start at 0/1 and aren't contiguous.
    assert f(np.array([310, 415, 415, 902, 902, 310])) is None
    assert f(np.array([310, 415, 415, 902, 902, 310]), "seurat_clusters") == 3   # ...unless named like one
    assert f(np.array([0, 1, 3, 3, 0])) is None          # gap in the codes, unnamed -> not claimed
    assert f(np.array([0, 1, 3, 3, 0]), "leiden") == 3   # a clustering with an empty level, rescued by name


def test_explicit_grouping_still_wins_and_partitions_ride_along():
    ds = _numeric_cluster_ds()
    pagoda3.write_viewer(ds, "celltypist")
    assert "stats_celltypist_sum" in ds.fields
    assert "stats_integrated_clusters_sum" in ds.fields, "a named grouping must not drop the clustering"
    assert ds.field("counts_cellmajor_order").provenance["group"] == "celltypist", \
        "an explicitly named grouping is the primary"


def test_no_partitions_is_unchanged_behaviour():
    ds, _, _ = _toy()
    pagoda3.write_viewer(ds, "leiden", also=["cell_type"])
    assert "stats_leiden_sum" in ds.fields and "stats_cell_type_sum" in ds.fields
