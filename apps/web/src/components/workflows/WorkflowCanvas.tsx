import "@xyflow/react/dist/base.css";
import "./workflowCanvas.css";

import type { WorkflowPosition, WorkflowStepId } from "@codenine/contracts";
import {
  Background,
  BackgroundVariant,
  type Connection,
  type Edge,
  type EdgeChange,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
  Panel,
  Position,
  ReactFlow,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import { MinusIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { ConnectorMark } from "../connectors/ConnectorMark";
import { Button } from "../ui/button";
import type { WorkflowSelection } from "./workflowEditStore";
import {
  freeStepPosition,
  leadFrameBounds,
  STEP_HEIGHT,
  STEP_WIDTH,
  WORKFLOW_STEP_LIMIT,
} from "./workflows.logic";

export type CanvasStepTone = "default" | "done" | "working" | "attention" | "failed" | "muted";

export interface CanvasStep {
  readonly id: WorkflowStepId;
  readonly title: string;
  /** The agent's name, the suggested agent's, or that there is none yet. */
  readonly agent: string;
  readonly agentTone: "agent" | "suggested" | "none";
  /** The model in the editor, the step's state in a run. */
  readonly detail: string;
  readonly tone: CanvasStepTone;
  /** Why the step cannot run yet, marked on its box. */
  readonly problem: string | null;
  readonly position: WorkflowPosition;
  readonly dependsOn: ReadonlyArray<WorkflowStepId>;
}

export interface CanvasTrigger {
  readonly kicker: string;
  readonly title: string;
  readonly detail: string;
  readonly position: WorkflowPosition;
}

export interface CanvasLead {
  readonly model: string;
  readonly activity: string;
  readonly goal: string;
}

type StepData = {
  readonly title: string;
  readonly agent: string;
  readonly agentTone: CanvasStep["agentTone"];
  readonly detail: string;
  readonly tone: CanvasStepTone;
  readonly problem: string | null;
  readonly editable: boolean;
};
type TriggerData = {
  readonly kicker: string;
  readonly title: string;
  readonly detail: string;
  readonly selected: boolean;
};
type LeadData = {
  readonly model: string;
  readonly activity: string;
  readonly goal: string;
  readonly selected: boolean;
  readonly editable: boolean;
};
type StepFlowNode = Node<StepData, "step">;
type TriggerFlowNode = Node<TriggerData, "trigger">;
type LeadFlowNode = Node<LeadData, "lead">;
type FlowNode = StepFlowNode | TriggerFlowNode | LeadFlowNode;

const TRIGGER_NODE = "@trigger";
const LEAD_NODE = "@lead";
const STEP_NODE_PREFIX = "step:";
const FIT_VIEW = { padding: 0.15, maxZoom: 1 } as const;
const MEASURED_NONE: ReadonlyMap<string, { width: number; height: number }> = new Map();
const POSITIONS_NONE: ReadonlyMap<string, WorkflowPosition> = new Map();
const IDS_NONE: ReadonlySet<string> = new Set();

const stepNodeId = (id: WorkflowStepId) => `${STEP_NODE_PREFIX}${id}`;
const stepIdOf = (nodeId: string) =>
  nodeId.startsWith(STEP_NODE_PREFIX)
    ? (nodeId.slice(STEP_NODE_PREFIX.length) as WorkflowStepId)
    : null;

function selectionOfNode(nodeId: string): WorkflowSelection | null {
  if (nodeId === TRIGGER_NODE) return { kind: "trigger" };
  if (nodeId === LEAD_NODE) return { kind: "lead" };
  const id = stepIdOf(nodeId);
  return id === null ? null : { kind: "step", id };
}

// Nodes and edges keep their identity while nothing they show changes, so React Flow re-renders
// only the boxes an edit touches, not every box on each keystroke in the side panel.
const elementCaches = new WeakMap<object, Map<string, { key: string; value: unknown }>>();

function cached<T>(scope: object, id: string, key: string, build: () => T): T {
  let cache = elementCaches.get(scope);
  if (cache === undefined) {
    cache = new Map();
    elementCaches.set(scope, cache);
  }
  const hit = cache.get(id);
  if (hit !== undefined && hit.key === key) return hit.value as T;
  const value = build();
  cache.set(id, { key, value });
  return value;
}

const HANDLE_CLASS =
  "size-2.5 rounded-full border border-muted-foreground/60 bg-background transition-colors hover:border-primary";

const STEP_TONE_CLASS: Record<CanvasStepTone, string> = {
  default: "border-border bg-card",
  done: "border-border bg-card",
  working: "border-info/40 bg-card",
  attention: "border-warning/50 bg-warning/6",
  failed: "border-destructive/40 bg-card",
  muted: "border-border bg-card opacity-72",
};

const STEP_DETAIL_CLASS: Record<CanvasStepTone, string> = {
  default: "text-muted-foreground",
  done: "text-success-foreground",
  working: "text-info-foreground",
  attention: "text-warning-foreground",
  failed: "text-destructive-foreground",
  muted: "text-muted-foreground",
};

function StepNode({ data, selected }: NodeProps<StepFlowNode>) {
  return (
    <div
      className={cn(
        "flex h-24 w-44 flex-col gap-1.5 rounded-xl border px-3 py-2.5 shadow-xs/5",
        STEP_TONE_CLASS[data.tone],
        selected && "border-primary ring-2 ring-primary/25",
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={data.editable}
        className={cn(HANDLE_CLASS, !data.editable && "opacity-0")}
      />
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-semibold text-foreground text-sm">
          {data.title}
        </span>
        {data.problem === null ? null : (
          <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-warning-foreground" />
        )}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-foreground text-xs">
        <ConnectorMark
          name={data.agent}
          size="sm"
          tone={
            data.agentTone === "agent"
              ? "agent"
              : data.agentTone === "suggested"
                ? "suggested"
                : "neutral"
          }
        />
        <span className={cn("truncate", data.agentTone === "none" && "text-muted-foreground")}>
          {data.agent}
        </span>
      </span>
      <span className={cn("truncate text-xs", STEP_DETAIL_CLASS[data.tone])}>{data.detail}</span>
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={data.editable}
        className={cn(HANDLE_CLASS, !data.editable && "opacity-0")}
      />
    </div>
  );
}

function TriggerNode({ data }: NodeProps<TriggerFlowNode>) {
  return (
    <div
      className={cn(
        "flex h-24 w-40 flex-col justify-center gap-1 rounded-l-4xl rounded-r-xl border bg-card py-3 pr-3.5 pl-5 shadow-xs/5",
        data.selected ? "border-primary ring-2 ring-primary/25" : "border-border",
      )}
    >
      <span className="font-semibold text-3xs text-muted-foreground uppercase tracking-wider">
        {data.kicker}
      </span>
      <span className="truncate font-semibold text-foreground text-sm">{data.title}</span>
      <span className="truncate text-muted-foreground text-xs">{data.detail}</span>
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        className={cn(HANDLE_CLASS, "opacity-0")}
      />
    </div>
  );
}

function LeadNode({ data }: NodeProps<LeadFlowNode>) {
  return (
    <div
      className={cn(
        "flex size-full items-start gap-3 rounded-2xl border border-dashed px-4 py-3.5",
        data.selected ? "border-primary bg-primary/6" : "border-primary/40 bg-primary/3",
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        className={cn(HANDLE_CLASS, "opacity-0")}
      />
      <ConnectorMark name="Lead" tone="agent" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm">
          <span className="font-semibold text-foreground">Lead</span>
          <span className="text-muted-foreground">
            {" "}
            · {data.model} · {data.activity}
          </span>
        </span>
        <span className="truncate text-muted-foreground text-xs">
          {data.goal.trim() === ""
            ? data.editable
              ? "Open the lead to set the outcome you want."
              : "No goal"
            : `Goal: ${data.goal}`}
        </span>
      </span>
    </div>
  );
}

const NODE_TYPES = {
  step: StepNode,
  trigger: TriggerNode,
  lead: LeadNode,
} satisfies NodeTypes;

/**
 * A workflow drawn as its trigger, the lead's frame and the steps inside it. The editor moves,
 * connects and selects boxes; a run's canvas only reports which box was opened.
 */
export function WorkflowCanvas(props: {
  readonly mode: "edit" | "run";
  readonly trigger: CanvasTrigger;
  readonly lead: CanvasLead;
  readonly steps: ReadonlyArray<CanvasStep>;
  readonly selection: WorkflowSelection | null;
  readonly onSelect: (selection: WorkflowSelection | null) => void;
  readonly onMoveStep?: (id: WorkflowStepId, position: WorkflowPosition) => void;
  readonly onMoveTrigger?: (position: WorkflowPosition) => void;
  readonly canConnect?: (from: WorkflowStepId, to: WorkflowStepId) => boolean;
  readonly onConnect?: (from: WorkflowStepId, to: WorkflowStepId) => void;
  readonly onDisconnect?: (from: WorkflowStepId, to: WorkflowStepId) => void;
  readonly onAddStep?: (position: WorkflowPosition) => void;
}) {
  const editable = props.mode === "edit";
  const [scope] = useState(() => ({}));
  const [measured, setMeasured] = useState(MEASURED_NONE);
  const [dragged, setDragged] = useState(POSITIONS_NONE);
  const [selectedEdges, setSelectedEdges] = useState(IDS_NONE);
  const selection = props.selection;

  const stepPositions = props.steps.map(
    (step) => dragged.get(stepNodeId(step.id)) ?? step.position,
  );
  const frame = leadFrameBounds(stepPositions);
  const nodeSize = (id: string) => {
    const size = measured.get(id);
    return size === undefined ? "" : `${size.width}x${size.height}`;
  };
  const withMeasured = (id: string) => {
    const size = measured.get(id);
    return size === undefined ? {} : { measured: size };
  };

  const leadData: LeadData = {
    ...props.lead,
    selected: selection?.kind === "lead",
    editable,
  };
  const leadNode = cached<LeadFlowNode>(
    scope,
    LEAD_NODE,
    JSON.stringify([leadData, frame, nodeSize(LEAD_NODE)]),
    () => ({
      id: LEAD_NODE,
      type: "lead",
      position: { x: frame.x, y: frame.y },
      width: frame.width,
      height: frame.height,
      zIndex: -1,
      draggable: false,
      connectable: false,
      deletable: false,
      ariaLabel: `Lead, ${props.lead.model}. ${editable ? "Open its settings." : props.lead.activity}`,
      data: leadData,
      ...withMeasured(LEAD_NODE),
    }),
  );
  const triggerPosition = dragged.get(TRIGGER_NODE) ?? props.trigger.position;
  const triggerData: TriggerData = {
    kicker: props.trigger.kicker,
    title: props.trigger.title,
    detail: props.trigger.detail,
    selected: selection?.kind === "trigger",
  };
  const triggerNode = cached<TriggerFlowNode>(
    scope,
    TRIGGER_NODE,
    JSON.stringify([triggerData, triggerPosition, nodeSize(TRIGGER_NODE)]),
    () => ({
      id: TRIGGER_NODE,
      type: "trigger",
      position: triggerPosition,
      draggable: editable,
      connectable: false,
      deletable: false,
      ariaLabel: `${props.trigger.title}, ${props.trigger.detail}${editable ? ". Open when it runs." : ""}`,
      data: triggerData,
      ...withMeasured(TRIGGER_NODE),
    }),
  );
  const stepNodes = props.steps.map((step, index) => {
    const id = stepNodeId(step.id);
    const position = stepPositions[index] ?? step.position;
    const selected = selection?.kind === "step" && selection.id === step.id;
    const data: StepData = {
      title: step.title,
      agent: step.agent,
      agentTone: step.agentTone,
      detail: step.detail,
      tone: step.tone,
      problem: step.problem,
      editable,
    };
    return cached<StepFlowNode>(
      scope,
      id,
      JSON.stringify([data, position, selected, nodeSize(id)]),
      () => ({
        id,
        type: "step",
        position,
        selected,
        draggable: editable,
        connectable: editable,
        deletable: false,
        ariaLabel: [step.title, step.agent, step.detail, step.problem]
          .filter((part) => part !== null && part !== "")
          .join(", "),
        data,
        ...withMeasured(id),
      }),
    );
  });
  const nodes: FlowNode[] = [leadNode, triggerNode, ...stepNodes];

  const leadEdge = cached<Edge>(scope, "edge:@trigger", "", () => ({
    id: "@trigger->@lead",
    source: TRIGGER_NODE,
    target: LEAD_NODE,
    selectable: false,
    deletable: false,
    focusable: false,
    markerEnd: { type: MarkerType.ArrowClosed },
  }));
  const titles = new Map(props.steps.map((step) => [step.id, step.title]));
  const edges: Edge[] = [
    leadEdge,
    ...props.steps.flatMap((step) =>
      step.dependsOn.flatMap((dependency) => {
        const from = titles.get(dependency);
        if (from === undefined) return [];
        const id = `${dependency}->${step.id}`;
        const selected = selectedEdges.has(id);
        const ariaLabel = `${step.title} gets the result of ${from}`;
        return [
          cached<Edge>(
            scope,
            `edge:${id}`,
            JSON.stringify([selected, editable, ariaLabel]),
            () => ({
              id,
              source: stepNodeId(dependency),
              target: stepNodeId(step.id),
              selected,
              selectable: editable,
              deletable: editable,
              focusable: editable,
              ariaLabel,
              markerEnd: { type: MarkerType.ArrowClosed },
            }),
          ),
        ];
      }),
    ),
  ];

  const onNodesChange = (changes: ReadonlyArray<NodeChange<FlowNode>>) => {
    let nextMeasured: Map<string, { width: number; height: number }> | null = null;
    let nextDragged: Map<string, WorkflowPosition> | null = null;
    let picked: WorkflowSelection | null | undefined;
    const moved: Array<readonly [string, WorkflowPosition]> = [];
    for (const change of changes) {
      switch (change.type) {
        case "dimensions": {
          const size = change.dimensions;
          const current = (nextMeasured ?? measured).get(change.id);
          if (
            size !== undefined &&
            (current?.width !== size.width || current.height !== size.height)
          ) {
            nextMeasured ??= new Map(measured);
            nextMeasured.set(change.id, { width: size.width, height: size.height });
          }
          break;
        }
        case "position": {
          nextDragged ??= new Map(dragged);
          if (change.dragging === true && change.position !== undefined) {
            nextDragged.set(change.id, change.position);
          } else {
            const position = change.position ?? nextDragged.get(change.id);
            nextDragged.delete(change.id);
            if (position !== undefined) moved.push([change.id, position]);
          }
          break;
        }
        case "select": {
          if (change.selected) picked = selectionOfNode(change.id);
          else if (picked === undefined && isSelected(selection, change.id)) picked = null;
          break;
        }
        default:
          break;
      }
    }
    if (nextMeasured !== null) setMeasured(nextMeasured);
    if (nextDragged !== null) setDragged(nextDragged);
    for (const [id, position] of moved) {
      if (id === TRIGGER_NODE) props.onMoveTrigger?.(position);
      const stepId = stepIdOf(id);
      if (stepId !== null) props.onMoveStep?.(stepId, position);
    }
    if (picked !== undefined) props.onSelect(picked);
  };

  const onEdgesChange = (changes: ReadonlyArray<EdgeChange>) => {
    let next: Set<string> | null = null;
    for (const change of changes) {
      if (change.type !== "select") continue;
      next ??= new Set(selectedEdges);
      if (change.selected) next.add(change.id);
      else next.delete(change.id);
    }
    if (next !== null) setSelectedEdges(next);
  };

  const endsOf = (connection: Pick<Connection, "source" | "target">) => {
    const from = stepIdOf(connection.source);
    const to = stepIdOf(connection.target);
    return from === null || to === null ? null : { from, to };
  };

  return (
    <ReactFlow<FlowNode, Edge>
      data-workflow-canvas=""
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onEdgesDelete={(deleted) => {
        for (const edge of deleted) {
          const ends = endsOf(edge);
          if (ends !== null) props.onDisconnect?.(ends.from, ends.to);
        }
        setSelectedEdges(IDS_NONE);
      }}
      onConnect={(connection) => {
        const ends = endsOf(connection);
        if (ends !== null) props.onConnect?.(ends.from, ends.to);
      }}
      isValidConnection={(connection) => {
        const ends = endsOf(connection);
        return ends !== null && (props.canConnect?.(ends.from, ends.to) ?? false);
      }}
      onPaneClick={() => {
        if (selection !== null) props.onSelect(null);
      }}
      nodesDraggable={editable}
      nodesConnectable={editable}
      edgesFocusable={editable}
      elevateNodesOnSelect={false}
      selectionKeyCode={null}
      multiSelectionKeyCode={null}
      deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
      defaultMarkerColor={null}
      minZoom={0.3}
      maxZoom={1.75}
      fitView
      fitViewOptions={FIT_VIEW}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
      {editable ? (
        <AddStepButton
          positions={stepPositions}
          disabled={props.steps.length >= WORKFLOW_STEP_LIMIT}
          onAdd={(position) => props.onAddStep?.(position)}
        />
      ) : null}
      <ZoomControls />
      <MiniMap
        pannable
        zoomable
        ariaLabel="Map of the workflow"
        nodeBorderRadius={6}
        nodeClassName={(node) =>
          node.id === LEAD_NODE
            ? "workflow-minimap-lead"
            : node.selected
              ? "workflow-minimap-selected"
              : ""
        }
        className="overflow-hidden rounded-lg border border-border"
      />
    </ReactFlow>
  );
}

function isSelected(selection: WorkflowSelection | null, nodeId: string): boolean {
  const of = selectionOfNode(nodeId);
  if (selection === null || of === null || selection.kind !== of.kind) return false;
  return selection.kind !== "step" || (of.kind === "step" && of.id === selection.id);
}

function AddStepButton(props: {
  readonly positions: ReadonlyArray<WorkflowPosition>;
  readonly disabled: boolean;
  readonly onAdd: (position: WorkflowPosition) => void;
}) {
  const { screenToFlowPosition } = useReactFlow();
  const domNode = useStore((state) => state.domNode);
  return (
    <Panel position="top-left">
      <Button
        size="sm"
        variant="outline"
        disabled={props.disabled}
        title={props.disabled ? `A workflow has at most ${WORKFLOW_STEP_LIMIT} steps.` : undefined}
        onClick={() => {
          // New steps land in the middle of what the user is looking at.
          const rect = domNode?.getBoundingClientRect();
          const center =
            rect === undefined
              ? { x: 0, y: 0 }
              : screenToFlowPosition({
                  x: rect.left + rect.width / 2,
                  y: rect.top + rect.height / 2,
                });
          props.onAdd(
            freeStepPosition(
              { x: center.x - STEP_WIDTH / 2, y: center.y - STEP_HEIGHT / 2 },
              props.positions,
            ),
          );
        }}
      >
        <PlusIcon aria-hidden />
        Add step
      </Button>
    </Panel>
  );
}

function ZoomControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const zoom = useStore((state) => state.transform[2]);
  const minZoom = useStore((state) => state.minZoom);
  const maxZoom = useStore((state) => state.maxZoom);
  return (
    <Panel
      position="bottom-left"
      className="flex items-center gap-0.5 rounded-lg border border-border bg-popover p-0.5 shadow-xs/5"
    >
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Zoom out"
        disabled={zoom <= minZoom}
        onClick={() => void zoomOut()}
      >
        <MinusIcon aria-hidden />
      </Button>
      <span className="w-11 text-center text-muted-foreground text-xs tabular-nums">
        {Math.round(zoom * 100)}%
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Zoom in"
        disabled={zoom >= maxZoom}
        onClick={() => void zoomIn()}
      >
        <PlusIcon aria-hidden />
      </Button>
      <Button size="xs" variant="ghost" onClick={() => void fitView(FIT_VIEW)}>
        Fit
      </Button>
    </Panel>
  );
}
