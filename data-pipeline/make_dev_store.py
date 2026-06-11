"""Generate a rich *synthetic* L* store with the canonical schema the real pagoda2
export will also use, so the web app can be built against realistic data before the
real GSE192391 pipeline lands. Deterministic.

Usage:  python make_dev_store.py [out_path] [n_cells] [n_genes]

Schema (the contract the app binds to; the real store matches it):
  axes:   cells, genes, umap(coord), pca(coord), groups_leiden(derived),
          aspects(derived)
  fields: counts            measure (cells, genes)   CSC, state=raw
          umap / pca        embedding
          leiden/cell_type/sample/condition  label (cells)
          mito/n_umi/n_gene measure (cells)           QC
          od_score          measure (genes)           overdispersion
          aspect_scores     measure (cells, aspects)  geneset/program scores
          aspect_adjvar     measure (aspects)
          stats_leiden_{sum,sumsq,nexpr}  measure (groups_leiden, genes)  [viewer profile]
          markers_leiden_{lfc,padj}       measure (genes, groups_leiden)  [viewer profile]
"""
import json, os, sys
import numpy as np
import scipy.sparse as sp

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lstar", "python", "src"))
import lstar

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "web", "public", "sample.lstar.zarr")
NCELLS = int(sys.argv[2]) if len(sys.argv) > 2 else 8000
NGENES = int(sys.argv[3]) if len(sys.argv) > 3 else 2000


def main():
    rng = np.random.default_rng(20240611)
    K = 12                                            # clusters
    CELL_TYPES = ["Macrophage", "T cell", "B cell", "NK", "Monocyte", "DC",
                  "Fibroblast", "Endothelial", "Plasma", "Mast", "Neutrophil", "Platelet"]
    SAMPLES = [("D1", "control"), ("D2", "control"), ("D3", "control"),
               ("D4", "disease"), ("D5", "disease"), ("D6", "disease")]

    # --- cluster assignment; cluster 0 (Macrophage) is enriched in disease ---
    base_p = np.ones(K) / K
    cell_cluster = rng.choice(K, size=NCELLS, p=base_p)
    # sample/condition assignment, with cluster-0 cells biased toward disease donors
    samp_idx = np.empty(NCELLS, dtype=int)
    for i in range(NCELLS):
        if cell_cluster[i] == 0 and rng.random() < 0.62:
            samp_idx[i] = rng.integers(3, 6)          # disease donor
        else:
            samp_idx[i] = rng.integers(0, 6)
    sample = np.array([SAMPLES[s][0] for s in samp_idx])
    condition = np.array([SAMPLES[s][1] for s in samp_idx])

    # --- embedding: cluster blobs on a circle (UMAP-like) ---
    ang = np.linspace(0, 2 * np.pi, K, endpoint=False)
    centers = np.c_[2.6 * np.cos(ang), 2.6 * np.sin(ang)]
    umap = (centers[cell_cluster] + rng.standard_normal((NCELLS, 2)) * 0.42).astype("f4")

    # --- marker gene blocks: each cluster up-regulates a contiguous gene block ---
    block = NGENES // (K + 4)
    base_rate = np.exp(rng.normal(-1.6, 0.8, NGENES))           # housekeeping
    rate = np.tile(base_rate, (NCELLS, 1))
    marker_genes = {}
    for c in range(K):
        g0 = c * block
        gs = np.arange(g0, g0 + block)
        marker_genes[c] = gs
        boost = rng.uniform(6, 16)
        sel = cell_cluster == c
        rate[np.ix_(sel, gs)] *= boost
        # disease-driven extra boost on cluster 0's inflammatory block, carried by D5
        if c == 0:
            d5 = sel & (sample == "D5")
            rate[np.ix_(d5, gs[: block // 2])] *= 2.2

    counts = rng.poisson(rate).astype(np.int32)
    counts[counts > 250] = 250
    X = sp.csc_matrix(counts)
    genes = np.array([f"G{i:04d}" for i in range(NGENES)])
    # name a handful of well-known symbols into cluster-0 markers for demo realism
    for sym, gi in {"IL6": 2, "CXCL10": 4, "SOD2": 6, "CCL2": 8, "CD3D": block + 1,
                    "MS4A1": 2 * block + 1, "NKG7": 3 * block + 1, "CD14": 4 * block + 1}.items():
        if gi < NGENES:
            genes[gi] = sym

    # --- QC ---
    n_umi = np.asarray(X.sum(axis=1)).ravel().astype("f4")
    n_gene = np.asarray((X > 0).sum(axis=1)).ravel().astype("f4")
    mito = np.clip(rng.normal(np.where(cell_cluster == 6, 9, 4), 2.5, NCELLS), 0.2, 22).astype("f4")

    # --- per-gene overdispersion score (variance vs mean trend residual) ---
    Xl = X.copy().astype("f4"); Xl.data = np.log1p(Xl.data)
    g_mean = np.asarray(Xl.mean(axis=0)).ravel()
    g_sq = np.asarray(Xl.multiply(Xl).mean(axis=0)).ravel()
    g_var = np.maximum(g_sq - g_mean ** 2, 0)
    od_score = (g_var / (g_mean + 1e-3)).astype("f4")

    # --- viewer profile: cluster sufficient stats over (groups_leiden, genes) ---
    leiden = np.array([f"c{c}" for c in cell_cluster])
    groups = np.array([f"c{c}" for c in range(K)])
    S = np.zeros((K, NGENES), "f8"); SS = np.zeros((K, NGENES), "f8"); NE = np.zeros((K, NGENES), "f8")
    for c in range(K):
        sub = Xl[cell_cluster == c]
        S[c] = np.asarray(sub.sum(axis=0)).ravel()
        SS[c] = np.asarray(sub.multiply(sub).sum(axis=0)).ravel()
        NE[c] = np.asarray((sub > 0).sum(axis=0)).ravel()
    # marker tables: lfc = cluster mean(log1p) - rest mean(log1p); padj a monotone proxy
    n_c = np.array([(cell_cluster == c).sum() for c in range(K)])
    grand = g_mean
    lfc = np.zeros((NGENES, K), "f4"); padj = np.ones((NGENES, K), "f4")
    for c in range(K):
        mu_c = S[c] / max(n_c[c], 1)
        mu_rest = (Xl.sum(axis=0).A1 - S[c]) / max(NCELLS - n_c[c], 1)
        lfc[:, c] = (mu_c - mu_rest).astype("f4")
        z = lfc[:, c] * np.sqrt(NE[c] + 1)
        padj[:, c] = np.clip(np.exp(-np.abs(z)), 1e-12, 1).astype("f4")

    # --- aspects (geneset programs) scored per cell ---
    ASPECTS = ["Inflammatory response", "T-cell activation", "B-cell program",
               "Cytotoxicity", "Oxidative phosphorylation", "Stress / oxidative"]
    aspect_genes = [marker_genes[0], marker_genes[1], marker_genes[2], marker_genes[3],
                    np.arange(NGENES - block, NGENES), marker_genes[0][: block // 2]]
    aspect_scores = np.zeros((NCELLS, len(ASPECTS)), "f4")
    for a, gs in enumerate(aspect_genes):
        aspect_scores[:, a] = np.asarray(Xl[:, gs].mean(axis=1)).ravel()
    aspect_adjvar = aspect_scores.var(axis=0).astype("f4")
    aspect_adjvar = (aspect_adjvar / aspect_adjvar.max() * 4.6).astype("f4")

    # --- assemble the L* dataset ---
    ds = lstar.Dataset(kind="sample")
    ds.add_axis("cells", [f"cell{i}" for i in range(NCELLS)], role="observation")
    ds.add_axis("genes", genes.tolist(), role="feature")
    ds.add_axis("umap", ["umap0", "umap1"], origin="derived", role="coordinate")
    ds.add_axis("groups_leiden", groups.tolist(), origin="derived", role="feature")
    ds.add_axis("aspects", ASPECTS, origin="derived", role="feature")

    ds.add_field("counts", X, role="measure", span=["cells", "genes"], state="raw")
    ds.add_field("umap", umap, role="embedding", span=["cells", "umap"])
    ds.add_field("leiden", leiden.tolist(), role="label", span=["cells"])
    ds.add_field("cell_type", np.array([CELL_TYPES[c] for c in cell_cluster]).tolist(), role="label", span=["cells"])
    ds.add_field("sample", sample.tolist(), role="label", span=["cells"])
    ds.add_field("condition", condition.tolist(), role="label", span=["cells"])
    ds.add_field("mito", mito, role="measure", span=["cells"])
    ds.add_field("n_umi", n_umi, role="measure", span=["cells"])
    ds.add_field("n_gene", n_gene, role="measure", span=["cells"])
    ds.add_field("od_score", od_score, role="measure", span=["genes"])
    ds.add_field("aspect_scores", aspect_scores, role="measure", span=["cells", "aspects"])
    ds.add_field("aspect_adjvar", aspect_adjvar, role="measure", span=["aspects"])
    ds.add_field("stats_leiden_sum", S.astype("f4"), role="measure", span=["groups_leiden", "genes"])
    ds.add_field("stats_leiden_sumsq", SS.astype("f4"), role="measure", span=["groups_leiden", "genes"])
    ds.add_field("stats_leiden_nexpr", NE.astype("f4"), role="measure", span=["groups_leiden", "genes"])
    ds.add_field("markers_leiden_lfc", lfc, role="measure", span=["genes", "groups_leiden"])
    ds.add_field("markers_leiden_padj", padj, role="measure", span=["genes", "groups_leiden"])
    ds.profiles = list(getattr(ds, "profiles", [])) + ["viewer@0.1", "pagoda2.synthetic@0.1"]

    out = os.path.abspath(OUT)
    if os.path.exists(out):
        import shutil; shutil.rmtree(out)
    lstar.write(ds, out, chunk_elems=300_000)
    errs = [e for e in lstar.validate(ds) if e.startswith("ERROR")]
    meta = {"n_cells": NCELLS, "n_genes": NGENES, "clusters": K, "nnz": int(X.nnz),
            "axes": list(ds.axes), "fields": list(ds.fields), "validate_errors": errs}
    print(json.dumps(meta, indent=0))
    if errs:
        print("VALIDATE ERRORS:", errs); sys.exit(1)


if __name__ == "__main__":
    main()
