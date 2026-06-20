declare module "cytoscape-dagre" {
  import type cytoscape from "cytoscape";

  interface DagreLayoutOptions extends cytoscape.BaseLayoutOptions {
    name: "dagre";
    rankDir?: "TB" | "BT" | "LR" | "RL";
    nodeSep?: number;
    rankSep?: number;
    edgeSep?: number;
    animate?: boolean;
  }

  const dagre: cytoscape.Ext;
  export default dagre;
}
