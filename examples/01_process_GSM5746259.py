"""Process GSE192391 sample 1 (GSM5746259, human PBMC) into an L* store with the SAME
canonical schema as make_dev_store.py, so it drops straight into the web app.

Pipeline (scanpy, standing in for pagoda2.1 which isn't installable here — see plan1.0
Part A for the canonical pagoda2 `write_pagoda2` path): read 10x triplet -> QC filter ->
normalize/log1p -> HVG -> PCA -> kNN -> Leiden -> UMAP -> marker genes -> viewer-profile
fields. Single sample, so sample/condition are single-valued (the multi-donor confound
story lives in the synthetic store).

Usage: ../.venv/bin/python 01_process_GSM5746259.py
"""
import gzip, os, sys
import numpy as np
import scipy.io, scipy.sparse as sp

HERE = os.path.dirname(__file__)
SRC = os.path.join(HERE, "data", "GSM5746259")
PFX = "GSM5746259_MGI0369_1_SLAB-145-0"
OUT = os.path.join(HERE, "..", "web", "public", "real.lstar.zarr")
sys.path.insert(0, os.path.join(HERE, "..", "..", "lstar", "python", "src"))
sys.path.insert(0, os.path.join(HERE, "..", "py", "src"))
import lstar
import pagoda3
NHVG = 3000


def main():
    import scanpy as sc
    import anndata as ad
    # --- read 10x triplet (mtx is genes x cells) ---
    M = scipy.io.mmread(gzip.open(os.path.join(SRC, f"{PFX}.matrix.mtx.gz"))).T.tocsr()  # cells x genes
    feats = [l.decode().split("\t") for l in gzip.open(os.path.join(SRC, f"{PFX}.features.tsv.gz"))]
    bcs = [l.decode().strip() for l in gzip.open(os.path.join(SRC, f"{PFX}.barcodes.tsv.gz"))]
    symbols = [(f[1] if len(f) > 1 else f[0]).strip() for f in feats]
    # make symbols unique
    seen = {}; uniq = []
    for s in symbols:
        if s in seen: seen[s] += 1; uniq.append(f"{s}.{seen[s]}")
        else: seen[s] = 0; uniq.append(s)
    A = ad.AnnData(X=M.astype("float32"))
    A.obs_names = bcs[: A.n_obs]; A.var_names = uniq[: A.n_vars]
    print(f"loaded {A.n_obs} cells x {A.n_vars} genes", flush=True)

    # --- QC ---
    A.var["mt"] = A.var_names.str.upper().str.startswith("MT-")
    sc.pp.calculate_qc_metrics(A, qc_vars=["mt"], inplace=True, percent_top=None)
    sc.pp.filter_cells(A, min_genes=200)
    sc.pp.filter_genes(A, min_cells=3)
    A = A[A.obs.pct_counts_mt < 20].copy()
    print(f"after QC: {A.n_obs} cells x {A.n_vars} genes", flush=True)

    A.layers["counts"] = A.X.copy()                      # keep raw counts
    n_umi = np.asarray(A.layers["counts"].sum(1)).ravel().astype("f4")
    n_gene = np.asarray((A.layers["counts"] > 0).sum(1)).ravel().astype("f4")
    mito = A.obs["pct_counts_mt"].to_numpy().astype("f4")

    # --- normalize, HVG, PCA, graph, leiden, umap ---
    sc.pp.normalize_total(A, target_sum=1e4); sc.pp.log1p(A)
    sc.pp.highly_variable_genes(A, n_top_genes=NHVG)
    A = A[:, A.var.highly_variable].copy()               # subset to HVG (lean store)
    Araw = A.layers["counts"].tocsc()                    # cells x HVG, raw counts CSC
    sc.pp.scale(A, max_value=10)
    sc.tl.pca(A, n_comps=50)
    sc.pp.neighbors(A, n_neighbors=15, n_pcs=50)
    sc.tl.leiden(A, resolution=1.0, flavor="igraph", n_iterations=2, directed=False)
    sc.tl.umap(A)
    sc.tl.rank_genes_groups(A, "leiden", method="wilcoxon")
    genes = list(A.var_names)
    ngenes = len(genes)
    umap = A.obsm["X_umap"].astype("f4")
    leiden = A.obs["leiden"].to_numpy()
    groups = sorted(set(leiden), key=lambda x: int(x))
    print(f"{len(groups)} leiden clusters", flush=True)

    # --- viewer-profile fields over log1p ---
    Xl = Araw.copy().astype("f4"); Xl.data = np.log1p(Xl.data); Xl = Xl.tocsr()
    K = len(groups); gi = {g: i for i, g in enumerate(groups)}
    S = np.zeros((K, ngenes), "f4"); SS = np.zeros((K, ngenes), "f4"); NE = np.zeros((K, ngenes), "f4")
    for g in groups:
        sub = Xl[leiden == g]
        S[gi[g]] = np.asarray(sub.sum(0)).ravel(); SS[gi[g]] = np.asarray(sub.multiply(sub).sum(0)).ravel(); NE[gi[g]] = np.asarray((sub > 0).sum(0)).ravel()
    nper = np.array([(leiden == g).sum() for g in groups])
    grand = np.asarray(Xl.sum(0)).ravel()
    lfc = np.zeros((ngenes, K), "f4"); padj = np.ones((ngenes, K), "f4")
    for g in groups:
        c = gi[g]; mu_c = S[c] / max(nper[c], 1); mu_rest = (grand - S[c]) / max(A.n_obs - nper[c], 1)
        lfc[:, c] = mu_c - mu_rest; padj[:, c] = np.clip(np.exp(-np.abs(lfc[:, c] * np.sqrt(NE[c] + 1))), 1e-12, 1)
    od = np.zeros(ngenes, "f4")
    gm = grand / A.n_obs; gsq = np.asarray(Xl.multiply(Xl).sum(0)).ravel() / A.n_obs
    od = ((np.maximum(gsq - gm ** 2, 0)) / (gm + 1e-3)).astype("f4")

    # aspects: per-cell mean log1p over each cluster's top markers
    names = A.uns["rank_genes_groups"]["names"]
    ASP = [f"Program {g}" for g in groups[:6]]
    aspect_scores = np.zeros((A.n_obs, len(ASP)), "f4")
    for a, g in enumerate(groups[:6]):
        top = [genes.index(n) for n in list(names[g][:30]) if n in genes][:30]
        if top: aspect_scores[:, a] = np.asarray(Xl[:, top].mean(1)).ravel()
    aspect_adjvar = aspect_scores.var(0).astype("f4"); aspect_adjvar = (aspect_adjvar / max(aspect_adjvar.max(), 1e-6) * 4.6).astype("f4")

    # --- assemble ---
    ct = np.array([f"cluster {g}" for g in leiden])
    smp = np.array(["GSM5746259"] * A.n_obs); cond = np.array(["PBMC"] * A.n_obs)
    ds = lstar.Dataset(kind="sample")
    ds.add_axis("cells", list(A.obs_names), role="observation")
    ds.add_axis("genes", genes, role="feature")
    ds.add_axis("umap", ["umap0", "umap1"], origin="derived", role="coordinate")
    ds.add_axis("groups_leiden", [f"c{g}" for g in groups], origin="derived", role="feature")
    ds.add_axis("aspects", ASP, origin="derived", role="feature")
    ds.add_field("counts", Araw, role="measure", span=["cells", "genes"], state="raw")
    ds.add_field("umap", umap, role="embedding", span=["cells", "umap"])
    ds.add_field("leiden", [f"c{x}" for x in leiden], role="label", span=["cells"])
    ds.add_field("cell_type", list(ct), role="label", span=["cells"])
    ds.add_field("sample", list(smp), role="label", span=["cells"])
    ds.add_field("condition", list(cond), role="label", span=["cells"])
    ds.add_field("mito", mito, role="measure", span=["cells"])
    ds.add_field("n_umi", n_umi, role="measure", span=["cells"])
    ds.add_field("n_gene", n_gene, role="measure", span=["cells"])
    ds.add_field("od_score", od, role="measure", span=["genes"])
    ds.add_field("aspect_scores", aspect_scores, role="measure", span=["cells", "aspects"])
    ds.add_field("aspect_adjvar", aspect_adjvar, role="measure", span=["aspects"])
    ds.add_field("stats_leiden_sum", S, role="measure", span=["groups_leiden", "genes"])
    ds.add_field("stats_leiden_sumsq", SS, role="measure", span=["groups_leiden", "genes"])
    ds.add_field("stats_leiden_nexpr", NE, role="measure", span=["groups_leiden", "genes"])
    ds.add_field("markers_leiden_lfc", lfc, role="measure", span=["genes", "groups_leiden"])
    ds.add_field("markers_leiden_padj", padj, role="measure", span=["genes", "groups_leiden"])
    # top up the viewer profile: od_genes + the cell-major de_panel (CSR log1p) for O(rows)
    # selection DE. Idempotent — skips the cluster stats/markers already added above.
    pagoda3.write_viewer(ds, "leiden")
    ds.profiles = list(ds.profiles) + ["scanpy@1"]
    out = os.path.abspath(OUT)
    if os.path.exists(out):
        import shutil; shutil.rmtree(out)
    lstar.write(ds, out, chunk_elems=300_000)
    errs = [e for e in lstar.validate(ds) if e.startswith("ERROR")]
    print(f"wrote {out}: {A.n_obs} cells x {ngenes} HVG, {K} clusters; validate_errors={errs}", flush=True)
    sys.exit(1 if errs else 0)


if __name__ == "__main__":
    main()
