"""pagoda3 store prep — `write_viewer` precomputes the *global* navigators the viewer opens with,
on top of an lstar dataset. This is viewer *policy* (which summaries to precompute) and so lives in
pagoda3, not in lstar; the heavy reduction runs on lstar's shared kernel (`lstar.col_sum_by_group`).

What is precomputed (all optional to a plain reader): per-annotation cluster stats + ranked marker
tables (one set for each label in `c(grouping, *also)`), a whole-dataset `od_score` (overdispersion
vs the smoothed mean-variance trend), a cluster-coherent `cell_order`, and `counts_cellmajor`
(counts in cell-major / CSR orientation). Everything *scope-dependent* — selection DE, subset HVG —
is left to the viewer's on-the-fly compute, because a global gene subset is wrong for a local
question. write_viewer recomputes & overwrites, so a same-named field can't go stale.
"""
import numpy as np
import scipy.sparse as sp
import lstar


def write_viewer(ds, grouping="leiden", counts="counts", engine="auto", also=()):
    """Add the `viewer@0.1` profile (navigator fields) to an lstar dataset; returns ds."""
    X = ds.field(counts).values
    X = sp.csc_matrix(X) if not sp.issparse(X) else X.tocsc()
    ncells, ngenes = X.shape
    Xl = X.copy().astype("f8"); Xl.data = np.log1p(Xl.data)
    grand = np.asarray(Xl.sum(0)).ravel()

    def markers_for(labels):
        labels = np.asarray(labels).astype(str)
        groups = sorted(set(labels.tolist()))
        code = np.array([groups.index(l) for l in labels]); K = len(groups)
        S, SS, NE = lstar.col_sum_by_group(X, code, K, lognorm=True, engine=engine)  # shared kernel
        S, SS, NE = np.asarray(S), np.asarray(SS), np.asarray(NE)
        nper = np.array([(code == g).sum() for g in range(K)])
        lfc = np.zeros((ngenes, K), "f4"); padj = np.ones((ngenes, K), "f4")
        for g in range(K):
            mu = S[g] / max(nper[g], 1); mr = (grand - S[g]) / max(ncells - nper[g], 1)
            lfc[:, g] = (mu - mr).astype("f4")
            padj[:, g] = np.clip(np.exp(-np.abs((mu - mr) * np.sqrt(NE[g] + 1))), 1e-12, 1).astype("f4")
        return groups, code, S, SS, NE, lfc, padj

    # substrate: counts in cell-major (CSR) orientation, all genes
    ds.add_field("counts_cellmajor", X.tocsr(), role="measure", span=["cells", "genes"], state="raw", encoding="csr")

    # whole-dataset overdispersion navigator: residual above the smoothed log(v) ~ log(m) trend
    gm = grand / ncells
    gv = np.maximum(np.asarray(Xl.multiply(Xl).sum(0)).ravel() / ncells - gm ** 2, 0)
    od = np.zeros(ngenes, "f4"); ok = (gm > 0) & (gv > 0) & np.isfinite(gm) & np.isfinite(gv)
    if ok.sum() > 10:
        coef = np.polyfit(np.log(gm[ok]), np.log(gv[ok]), 2)
        od[ok] = (np.log(gv[ok]) - np.polyval(coef, np.log(gm[ok]))).astype("f4")
    ds.add_field("od_score", od, role="measure", span=["genes"])

    # per-annotation cluster stats + marker navigators (one set each)
    primary_code = None
    for gp in dict.fromkeys([grouping, *also]):
        if gp not in ds.fields:
            continue
        groups, code, S, SS, NE, lfc, padj = markers_for(ds.field(gp).values)
        if gp == grouping:
            primary_code = code
        ds.add_axis("groups_%s" % gp, groups, origin="derived", role="feature")
        sg = ["groups_%s" % gp, "genes"]
        ds.add_field("stats_%s_sum" % gp, S.astype("f4"), role="measure", span=sg)
        ds.add_field("stats_%s_sumsq" % gp, SS.astype("f4"), role="measure", span=sg)
        ds.add_field("stats_%s_nexpr" % gp, NE.astype("f4"), role="measure", span=sg)
        ds.add_field("markers_%s_lfc" % gp, lfc, role="measure", span=["genes", "groups_%s" % gp])
        ds.add_field("markers_%s_padj" % gp, padj, role="measure", span=["genes", "groups_%s" % gp])

    order = np.argsort(primary_code, kind="stable").astype("i8")
    ds.add_field("cell_order", order, role="measure", span=["cells"], state="permutation")
    if "viewer@0.1" not in ds.profiles:
        ds.profiles.append("viewer@0.1")
    return ds
