// A compact, bundled marker database for scType-style scoring (no network needed). Canonical PBMC/immune
// markers — `+` positive, `-` negative. This is a starter set; the user/agent can extend or swap it, and a
// fuller scTypeDB/PanglaoDB JSON can be loaded later. Symbols are HGNC; missing genes are dropped at scoring.
export interface MarkerSet { positive: string[]; negative?: string[] }
export type MarkerDB = Record<string, MarkerSet>;

export const PBMC_MARKERS: MarkerDB = {
  "CD4 T cell": { positive: ["CD3D", "CD3E", "TRAC", "IL7R", "CD4"], negative: ["CD8A", "CD8B", "NKG7", "MS4A1"] },
  "CD8 T cell": { positive: ["CD3D", "CD3E", "TRAC", "CD8A", "CD8B"], negative: ["CD4", "MS4A1", "CD14"] },
  "Regulatory T cell": { positive: ["CD3D", "FOXP3", "IL2RA", "CTLA4", "IKZF2"], negative: ["CD8A", "NKG7"] },
  "Naive T cell": { positive: ["CCR7", "SELL", "TCF7", "LEF1", "CD3E"], negative: ["GZMB", "NKG7"] },
  "NK cell": { positive: ["GNLY", "NKG7", "KLRD1", "NCAM1", "GZMB", "KLRF1"], negative: ["CD3D", "CD3E", "CD14"] },
  "B cell": { positive: ["CD79A", "CD79B", "MS4A1", "CD19", "HLA-DRA"], negative: ["CD3D", "CD14", "NKG7"] },
  "Naive B cell": { positive: ["MS4A1", "CD79A", "TCL1A", "IGHD", "FCER2"], negative: ["CD3D", "CD27"] },
  "Memory B cell": { positive: ["MS4A1", "CD79A", "CD27", "TNFRSF13B"], negative: ["CD3D", "TCL1A"] },
  "Plasma cell": { positive: ["MZB1", "JCHAIN", "XBP1", "CD38", "PRDM1"], negative: ["MS4A1", "CD3D"] },
  "CD14+ monocyte": { positive: ["CD14", "LYZ", "S100A8", "S100A9", "VCAN"], negative: ["FCGR3A", "CD3D", "MS4A1"] },
  "CD16+ monocyte": { positive: ["FCGR3A", "MS4A7", "LYZ", "CDKN1C"], negative: ["CD14", "CD3D"] },
  "Dendritic cell": { positive: ["FCER1A", "CST3", "CLEC9A", "CD1C"], negative: ["CD3D", "CD14"] },
  "Plasmacytoid DC": { positive: ["LILRA4", "IL3RA", "GZMB", "IRF7", "TCF4"], negative: ["CD3D", "CD14", "MS4A1"] },
  "Platelet": { positive: ["PPBP", "PF4", "ITGA2B", "TUBB1"], negative: ["CD3D", "PTPRC"] },
  "Erythrocyte": { positive: ["HBB", "HBA1", "HBA2", "ALAS2"], negative: ["PTPRC", "CD3D"] },
  "HSPC": { positive: ["CD34", "KIT", "SOX4", "SPINK2"], negative: ["CD3D", "CD14"] },
  "Cycling cell": { positive: ["MKI67", "TOP2A", "STMN1", "TUBA1B"], negative: [] },
};
