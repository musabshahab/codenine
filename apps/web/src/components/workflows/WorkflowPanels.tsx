import type { EnvironmentProject } from "@codenine/client-runtime/state/models";
import type {
  AgentSummary,
  EnvironmentId,
  ProjectId,
  WorkflowApprovals,
  WorkflowDefinition,
  WorkflowMissedRuns,
  WorkflowProblem,
  WorkflowSchedule,
  WorkflowStep,
} from "@codenine/contracts";
import { CheckIcon, ChevronDownIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

import { agentTitle } from "../agents/useAgents";
import { ConnectorMark } from "../connectors/ConnectorMark";
import { TextField } from "../TextField";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Label } from "../ui/label";
import { RadioCard, RadioGroup } from "../ui/radio-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { ModelField } from "./ModelField";
import type { WorkflowSelection } from "./workflowEditStore";
import {
  assignStepAgent,
  removeStep,
  updateStep,
  upcomingRunsLine,
  WEEKDAY_NAMES,
  WEEKDAY_SHORT,
  WEEKDAYS,
  WORKFLOW_INPUT_LIMIT,
  WORKFLOW_NOTES_MAX,
} from "./workflows.logic";

type ChangeWorkflow = (change: (definition: WorkflowDefinition) => WorkflowDefinition) => void;

const APPROVAL_CHOICES = [
  {
    value: "ask",
    title: "Ask me",
    description:
      "The run waits for your answer. What you've always allowed for an agent goes ahead.",
  },
  {
    value: "review",
    title: "Auto",
    description:
      "A reviewer allows what fits the goal and asks you about the rest. It doesn't see what agents read, so a page or email can't talk it round.",
  },
  { value: "never", title: "Never ask", description: "Agents go ahead without asking." },
] as const satisfies ReadonlyArray<{
  readonly value: WorkflowApprovals;
  readonly title: string;
  readonly description: string;
}>;

const MISSED_CHOICES = [
  { value: "once", title: "Run once when it's back", description: "However many it missed." },
  {
    value: "each",
    title: "Run each one it missed",
    description: "One after another, oldest first.",
  },
  {
    value: "skip",
    title: "Skip it",
    description: "Wait for the next time. Skipped runs show in the history.",
  },
] as const satisfies ReadonlyArray<{
  readonly value: WorkflowMissedRuns;
  readonly title: string;
  readonly description: string;
}>;

function PanelHeader(props: { readonly title: string; readonly onClose?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="min-w-0 truncate font-semibold text-base text-foreground">{props.title}</h2>
      {props.onClose === undefined ? null : (
        <Button size="icon-sm" variant="ghost-muted" aria-label="Close" onClick={props.onClose}>
          <XIcon aria-hidden />
        </Button>
      )}
    </div>
  );
}

// Whole-workflow problems carry no target; all but the step count are fixed on the lead.
function isLeadProblem(message: string): boolean {
  return !message.startsWith("Add a step") && !message.startsWith("A run can use");
}

function Hint(props: { readonly id?: string; readonly children: ReactNode }) {
  return (
    <p id={props.id} className="text-muted-foreground text-xs">
      {props.children}
    </p>
  );
}

function TextAreaField(props: {
  readonly label: string;
  readonly value: string;
  readonly rows: number;
  readonly disabled: boolean;
  readonly hint?: string;
  readonly placeholder?: string;
  readonly onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{props.label}</Label>
      <Textarea
        id={id}
        rows={props.rows}
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        aria-describedby={props.hint === undefined ? undefined : `${id}-hint`}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      />
      {props.hint === undefined ? null : <Hint id={`${id}-hint`}>{props.hint}</Hint>}
    </div>
  );
}

/** With nothing selected: the workflow's own name and description, and what keeps it from running. */
export function WorkflowPanel(props: {
  readonly definition: WorkflowDefinition;
  /** The folder name it saves under. */
  readonly savedAs: string | null;
  readonly problems: ReadonlyArray<WorkflowProblem>;
  readonly disabled: boolean;
  readonly onChange: ChangeWorkflow;
  readonly onSelect: (selection: WorkflowSelection) => void;
  readonly onDelete: (() => void) | null;
}) {
  const { definition } = props;
  return (
    <>
      <PanelHeader title="Workflow" />
      <TextField
        label="Name"
        placeholder="Weekly blog post"
        value={definition.title}
        disabled={props.disabled}
        hint={props.savedAs === null ? undefined : `Saved as ${props.savedAs}`}
        onChange={(title) => props.onChange((current) => ({ ...current, title }))}
      />
      <TextAreaField
        label="What it does"
        rows={3}
        value={definition.description}
        placeholder="Researches a topic, writes and edits a post, and publishes it on the blog."
        disabled={props.disabled}
        onChange={(description) => props.onChange((current) => ({ ...current, description }))}
      />
      {props.problems.length === 0 ? null : (
        <Alert variant="warning">
          <AlertTitle>It can't run yet</AlertTitle>
          <AlertDescription>
            <ul className="flex flex-col gap-1">
              {props.problems.map((problem) => (
                <li key={`${problem.step ?? ""}:${problem.message}`}>
                  {problem.step === null && !isLeadProblem(problem.message) ? (
                    problem.message
                  ) : (
                    <InlineButton
                      tone="muted"
                      onClick={() =>
                        props.onSelect(
                          problem.step === null
                            ? { kind: "lead" }
                            : { kind: "step", id: problem.step },
                        )
                      }
                    >
                      {problem.message}
                    </InlineButton>
                  )}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      <Hint>
        Select the trigger, the lead or a step on the canvas to change it. Drag from a step's right
        edge to another step to pass its result on.
      </Hint>
      {props.onDelete === null ? null : (
        <Button
          size="sm"
          variant="destructive-outline"
          className="mt-auto self-start"
          disabled={props.disabled}
          onClick={props.onDelete}
        >
          Delete workflow
        </Button>
      )}
    </>
  );
}

const DEFAULT_TIME = "09:00";

/** When it runs: on a schedule or only when started, what happens to missed runs, and its inputs. */
export function TriggerPanel(props: {
  readonly definition: WorkflowDefinition;
  readonly nowMs: number;
  readonly hour12: boolean;
  readonly disabled: boolean;
  readonly onChange: ChangeWorkflow;
  readonly onClose: () => void;
}) {
  const { definition } = props;
  const schedule = definition.trigger.schedule;
  const daysId = useId();
  const timeId = useId();
  const missedId = useId();
  // Switching to "When you start it" and back keeps the days and time chosen before.
  const [lastSchedule, setLastSchedule] = useState<WorkflowSchedule | null>(schedule);
  const setSchedule = (next: WorkflowSchedule | null) =>
    props.onChange((current) => ({
      ...current,
      trigger: { ...current.trigger, schedule: next },
    }));
  const changeSchedule = (change: Partial<WorkflowSchedule>) => {
    if (schedule === null) return;
    const next = { ...schedule, ...change };
    setLastSchedule(next);
    setSchedule(next);
  };
  const setInputs = (inputs: WorkflowDefinition["inputs"]) =>
    props.onChange((current) => ({ ...current, inputs }));
  return (
    <>
      <PanelHeader title="When it runs" onClose={props.onClose} />
      <ToggleGroup
        aria-label="Starts"
        className="w-full"
        value={[schedule === null ? "manual" : "schedule"]}
        disabled={props.disabled}
        onValueChange={(next) => {
          if (next[0] === "manual" && schedule !== null) setSchedule(null);
          if (next[0] === "schedule" && schedule === null) {
            setSchedule(
              lastSchedule ?? {
                days: ["mon"],
                time: DEFAULT_TIME,
                timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
              },
            );
          }
        }}
      >
        <Toggle value="schedule" className="flex-1">
          On a schedule
        </Toggle>
        <Toggle value="manual" className="flex-1">
          When you start it
        </Toggle>
      </ToggleGroup>
      {schedule === null ? (
        <Hint>It runs only when you choose Run now, from Workflows or from this page.</Hint>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span id={daysId} className="font-medium text-foreground text-sm">
              Days
            </span>
            <ToggleGroup
              multiple
              variant="outline"
              size="sm"
              aria-labelledby={daysId}
              value={schedule.days}
              disabled={props.disabled}
              onValueChange={(next) =>
                changeSchedule({
                  days: WEEKDAYS.filter((day) => next.includes(day)),
                })
              }
            >
              {WEEKDAYS.map((day) => (
                <Toggle key={day} value={day} aria-label={WEEKDAY_NAMES[day]}>
                  {WEEKDAY_SHORT[day]}
                </Toggle>
              ))}
            </ToggleGroup>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={timeId}>Time</Label>
            <Input
              id={timeId}
              type="time"
              className="w-32"
              value={schedule.time}
              disabled={props.disabled}
              onChange={(event) => {
                const time = event.currentTarget.value;
                if (/^([01]\d|2[0-3]):[0-5]\d$/u.test(time)) changeSchedule({ time });
              }}
            />
          </div>
          <TimeZoneField
            value={schedule.timeZone}
            disabled={props.disabled}
            onChange={(timeZone) => changeSchedule({ timeZone })}
          />
          <Hint>
            {schedule.days.length === 0
              ? "Choose at least one day."
              : (upcomingRunsLine(schedule, props.nowMs, props.hour12) ?? "")}
          </Hint>
        </div>
      )}
      {schedule === null ? null : (
        <div className="flex flex-col gap-1.5">
          <span id={missedId} className="font-medium text-foreground text-sm">
            If Codenine was off at that time
          </span>
          <RadioGroup
            aria-labelledby={missedId}
            value={definition.trigger.missedRuns}
            disabled={props.disabled}
            onValueChange={(value) => {
              const choice = MISSED_CHOICES.find((candidate) => candidate.value === value);
              if (choice === undefined) return;
              props.onChange((current) => ({
                ...current,
                trigger: { ...current.trigger, missedRuns: choice.value },
              }));
            }}
          >
            {MISSED_CHOICES.map((choice) => (
              <RadioCard
                key={choice.value}
                value={choice.value}
                title={choice.title}
                description={choice.description}
                selected={definition.trigger.missedRuns === choice.value}
                disabled={props.disabled}
              />
            ))}
          </RadioGroup>
          <Hint>
            Runs happen only while Codenine is running on this computer. A run cut off part way
            resumes from the step it was on.
          </Hint>
        </div>
      )}
      <section aria-label="What each run starts with" className="flex flex-col gap-2">
        <h3 className="font-medium text-foreground text-sm">What each run starts with</h3>
        {definition.inputs.map((input, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- inputs have no ids, and a name can be empty or repeat while typed
          <div key={index} className="flex items-center gap-2">
            <Input
              size="sm"
              className="w-32 shrink-0"
              aria-label={`Name of input ${index + 1}`}
              placeholder="Topic area"
              value={input.name}
              disabled={props.disabled}
              onChange={(event) => {
                const name = event.currentTarget.value;
                setInputs(
                  definition.inputs.map((entry, at) => (at === index ? { ...entry, name } : entry)),
                );
              }}
            />
            <Input
              size="sm"
              className="min-w-0 flex-1"
              aria-label={`Value of ${input.name.trim() || `input ${index + 1}`}`}
              placeholder="Its value each run"
              value={input.value}
              disabled={props.disabled}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setInputs(
                  definition.inputs.map((entry, at) =>
                    at === index ? { ...entry, value } : entry,
                  ),
                );
              }}
            />
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={`Remove ${input.name.trim() || `input ${index + 1}`}`}
              disabled={props.disabled}
              onClick={() => setInputs(definition.inputs.filter((_, at) => at !== index))}
            >
              <Trash2Icon aria-hidden />
            </Button>
          </div>
        ))}
        <Button
          size="xs"
          variant="outline"
          className="self-start"
          disabled={props.disabled || definition.inputs.length >= WORKFLOW_INPUT_LIMIT}
          onClick={() => setInputs([...definition.inputs, { name: "", value: "" }])}
        >
          <PlusIcon aria-hidden />
          Add input
        </Button>
        <Hint>
          Values every run starts with, such as a topic. Run now lets you change them for that run
          only.
        </Hint>
      </section>
    </>
  );
}

function timeZones(current: string): ReadonlyArray<string> {
  const zones = Intl.supportedValuesOf("timeZone");
  return zones.includes(current) ? zones : [current, ...zones];
}

function TimeZoneField(props: {
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (timeZone: string) => void;
}) {
  const labelId = useId();
  const [query, setQuery] = useState("");
  const zones = timeZones(props.value);
  const needle = query.trim().toLowerCase().replaceAll(" ", "_");
  const shown = needle === "" ? zones : zones.filter((zone) => zone.toLowerCase().includes(needle));
  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className="font-medium text-foreground text-sm">
        Time zone
      </span>
      <Combobox
        items={zones}
        filteredItems={shown}
        autoHighlight
        value={props.value}
        onOpenChange={(open) => {
          if (!open) setQuery("");
        }}
        onValueChange={(zone) => {
          if (typeof zone === "string" && zone !== props.value) props.onChange(zone);
        }}
      >
        <ComboboxTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-between"
              disabled={props.disabled}
              aria-labelledby={labelId}
            />
          }
        >
          <span className="truncate">{props.value}</span>
          <ChevronDownIcon aria-hidden className="opacity-60" />
        </ComboboxTrigger>
        <ComboboxPopup align="start" className="w-72">
          <ComboboxSearchInput
            aria-label="Search time zones"
            placeholder="Search time zones"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ComboboxEmpty>No matching time zone.</ComboboxEmpty>
          <ComboboxList>
            {(zone: string) => (
              <ComboboxItem key={zone} value={zone}>
                <span className="min-w-0 flex-1 truncate">{zone}</span>
                {zone === props.value ? <CheckIcon aria-hidden className="ml-auto" /> : null}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    </div>
  );
}

/** The lead: its model, the outcome it checks results against, where steps work, and limits. */
export function LeadPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly definition: WorkflowDefinition;
  readonly notes: string;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly disabled: boolean;
  readonly onChange: ChangeWorkflow;
  readonly onNotesChange: (notes: string) => void;
  readonly onClose: () => void;
}) {
  const { definition } = props;
  const lead = definition.lead;
  const approvalsId = useId();
  const limitsId = useId();
  const setLead = (change: Partial<WorkflowDefinition["lead"]>) =>
    props.onChange((current) => ({ ...current, lead: { ...current.lead, ...change } }));
  const projectTitle = (id: ProjectId | null) =>
    id === null
      ? "Choose a workspace"
      : (props.projects.find((project) => project.id === id)?.title ?? "A workspace that is gone");
  return (
    <>
      <PanelHeader title="Lead" onClose={props.onClose} />
      <Hint>
        The lead runs each step, checks the result against your goal, and sends it back with notes
        until it fits.
      </Hint>
      <ModelField
        environmentId={props.environmentId}
        label="Model"
        value={lead.model}
        fallback={null}
        subject="the lead"
        needsTools={false}
        disabled={props.disabled}
        onChange={(model) => setLead({ model })}
      />
      <TextAreaField
        label="The outcome you want"
        rows={5}
        value={lead.goal}
        placeholder="A new post on the blog every Monday, accurate, at least 800 words, on a topic not covered in the last three months."
        disabled={props.disabled}
        hint="The lead checks every result against this before the run moves on."
        onChange={(goal) => setLead({ goal })}
      />
      <div className="flex flex-col gap-1.5">
        <span className="font-medium text-foreground text-sm">Works in</span>
        <Select
          value={lead.projectId}
          disabled={props.disabled}
          onValueChange={(next) => {
            const project = props.projects.find((candidate) => candidate.id === next);
            if (project !== undefined) setLead({ projectId: project.id });
          }}
        >
          <SelectTrigger size="sm" aria-label="Works in">
            <SelectValue>{(value: ProjectId | null) => projectTitle(value)}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {props.projects.map((project) => (
              <SelectItem hideIndicator key={project.id} value={project.id}>
                {project.title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Hint>The workspace whose folder the steps work in.</Hint>
      </div>
      <div className="flex flex-col gap-1.5">
        <span id={approvalsId} className="font-medium text-foreground text-sm">
          When an agent wants to change something
        </span>
        <RadioGroup
          aria-labelledby={approvalsId}
          value={lead.approvals}
          disabled={props.disabled}
          onValueChange={(value) => {
            const choice = APPROVAL_CHOICES.find((candidate) => candidate.value === value);
            if (choice !== undefined) setLead({ approvals: choice.value });
          }}
        >
          {APPROVAL_CHOICES.map((choice) => (
            <RadioCard
              key={choice.value}
              value={choice.value}
              title={choice.title}
              description={choice.description}
              selected={lead.approvals === choice.value}
              disabled={props.disabled}
            />
          ))}
        </RadioGroup>
      </div>
      <TextAreaField
        label="Notes from past runs"
        rows={5}
        value={props.notes}
        placeholder="The lead adds a short note here after each run."
        disabled={props.disabled}
        hint={`The lead writes a short note after each run and reads them before the next one. You can edit them; older lines drop off past ${WORKFLOW_NOTES_MAX.toLocaleString("en-US")} characters.`}
        onChange={props.onNotesChange}
      />
      <div role="group" aria-labelledby={limitsId} className="flex flex-col gap-1.5">
        <span id={limitsId} className="font-medium text-foreground text-sm">
          Limits for each run
        </span>
        <div className="flex gap-2">
          <LimitField
            // Remounted when the limit changes elsewhere, such as Discard changes.
            key={`spend:${lead.limits.spendUsd ?? ""}`}
            label="Spending"
            unit="$"
            unitAt="start"
            value={lead.limits.spendUsd}
            decimals
            disabled={props.disabled}
            onChange={(spendUsd) => setLead({ limits: { ...lead.limits, spendUsd } })}
          />
          <LimitField
            key={`minutes:${lead.limits.minutes ?? ""}`}
            label="Time"
            unit="min"
            unitAt="end"
            value={lead.limits.minutes}
            decimals={false}
            disabled={props.disabled}
            onChange={(minutes) => setLead({ limits: { ...lead.limits, minutes } })}
          />
        </div>
        <Hint>
          At a limit the lead stops and asks you whether to go on. Leave one empty for no limit.
          This is also what stops a step being sent back forever.
        </Hint>
      </div>
    </>
  );
}

/** A limit typed as text and kept when the field is left, so "2." can become "2.50". */
function LimitField(props: {
  readonly label: string;
  readonly unit: string;
  readonly unitAt: "start" | "end";
  readonly value: number | null;
  readonly decimals: boolean;
  readonly disabled: boolean;
  readonly onChange: (value: number | null) => void;
}) {
  const id = useId();
  const [text, setText] = useState(props.value === null ? "" : String(props.value));
  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === "") {
      if (props.value !== null) props.onChange(null);
      return;
    }
    const parsed = Number(trimmed);
    const valid = props.decimals
      ? Number.isFinite(parsed) && parsed > 0
      : Number.isInteger(parsed) && parsed > 0;
    if (!valid) {
      setText(props.value === null ? "" : String(props.value));
      return;
    }
    const value = props.decimals ? Math.round(parsed * 100) / 100 : parsed;
    if (value !== props.value) props.onChange(value);
  };
  const addon = (
    <InputGroupAddon align={props.unitAt === "start" ? "inline-start" : "inline-end"}>
      {props.unit}
    </InputGroupAddon>
  );
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <Label htmlFor={id}>{props.label}</Label>
      <InputGroup>
        {props.unitAt === "start" ? addon : null}
        <InputGroupInput
          id={id}
          inputMode={props.decimals ? "decimal" : "numeric"}
          placeholder="No limit"
          value={text}
          disabled={props.disabled}
          onChange={(event) => setText(event.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
          }}
        />
        {props.unitAt === "end" ? addon : null}
      </InputGroup>
    </div>
  );
}

const APPROVAL_TITLES: Record<WorkflowApprovals, string> = {
  ask: "Ask me",
  review: "Auto",
  never: "Never ask",
};

/** A step: who does it, on which model, what it does each run, and what the lead checks. */
export function StepPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly definition: WorkflowDefinition;
  readonly step: WorkflowStep;
  readonly agents: ReadonlyArray<AgentSummary>;
  readonly problem: string | null;
  readonly disabled: boolean;
  readonly onChange: ChangeWorkflow;
  readonly onSelect: (selection: WorkflowSelection | null) => void;
  readonly onCreateAgent: () => void;
  readonly onEditAgent: (name: string) => void;
}) {
  const { definition, step } = props;
  const agentId = useId();
  const getsId = useId();
  const agent =
    step.agent === null
      ? null
      : (props.agents.find((candidate) => candidate.name === step.agent) ?? null);
  const agentName = step.agent === null ? null : agentTitle(step.agent, agent);
  const change = (update: (current: WorkflowStep) => WorkflowStep) =>
    props.onChange((current) => updateStep(current, step.id, update));
  const sources = step.dependsOn.flatMap((id) => {
    const source = definition.steps.find((candidate) => candidate.id === id);
    return source === undefined ? [] : [source];
  });
  const suggestion = step.agent === null ? step.suggestion : undefined;
  const agents = props.agents.toSorted((left, right) => left.title.localeCompare(right.title));
  return (
    <>
      <PanelHeader
        title={step.title.trim() || "Untitled step"}
        onClose={() => props.onSelect(null)}
      />
      {props.problem === null ? null : (
        <Alert variant="warning">
          <AlertDescription>{props.problem}</AlertDescription>
        </Alert>
      )}
      <TextField
        label="Name"
        value={step.title}
        disabled={props.disabled}
        onChange={(title) => change((current) => ({ ...current, title }))}
      />
      <div className="flex flex-col gap-1.5">
        <span id={agentId} className="font-medium text-foreground text-sm">
          Done by
        </span>
        <Select
          value={step.agent}
          disabled={props.disabled}
          onValueChange={(next) => {
            const chosen = props.agents.find((candidate) => candidate.name === next);
            if (chosen !== undefined) {
              props.onChange((current) => assignStepAgent(current, step.id, chosen));
            }
          }}
        >
          <SelectTrigger aria-labelledby={agentId}>
            <SelectValue>
              {(name: string | null) =>
                name === null ? (
                  <span className="text-muted-foreground">Choose one of your agents</span>
                ) : (
                  <span className="flex min-w-0 items-center gap-2">
                    <ConnectorMark name={agentName ?? name} size="sm" tone="agent" />
                    <span className="truncate">{agentName ?? name}</span>
                  </span>
                )
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {agents.map((candidate) => (
              <SelectItem hideIndicator key={candidate.name} value={candidate.name}>
                <span className="flex min-w-0 flex-col py-0.5">
                  <span className="truncate">{candidate.title}</span>
                  <span className="truncate text-muted-foreground text-xs">
                    {candidate.description}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {suggestion === undefined ? null : (
          <div className="flex flex-col gap-2 rounded-lg border border-primary/40 border-dashed p-3">
            <span className="flex min-w-0 items-center gap-2">
              <ConnectorMark name={suggestion.title} size="sm" tone="suggested" />
              <span className="truncate font-medium text-foreground text-sm">
                Suggested: {suggestion.title}
              </span>
            </span>
            <span className="text-muted-foreground text-xs">{suggestion.description}</span>
            <Button
              size="xs"
              variant="outline"
              className="self-start"
              disabled={props.disabled}
              onClick={props.onCreateAgent}
            >
              <PlusIcon aria-hidden />
              Create {suggestion.title} agent
            </Button>
          </div>
        )}
        {agent === null || step.agent === null ? null : (
          <InlineButton
            tone="muted"
            className="self-start"
            onClick={() => {
              if (step.agent !== null) props.onEditAgent(step.agent);
            }}
          >
            Edit the {agentName} agent
          </InlineButton>
        )}
        {agents.length === 0 && suggestion === undefined ? (
          <Hint>None of your agents yet. Make one on the Agents page, then come back.</Hint>
        ) : null}
      </div>
      <ModelField
        environmentId={props.environmentId}
        label="Model"
        value={step.model}
        fallback={{
          label: agentName === null ? "Its agent's own model" : `${agentName}'s own model`,
          model: agent?.model ?? null,
        }}
        subject={step.title.trim() || "this step"}
        needsTools={(agent?.connectors.length ?? 0) > 0}
        disabled={props.disabled}
        onChange={(model) => change((current) => ({ ...current, model }))}
      />
      <TextAreaField
        label="What it does each run"
        rows={4}
        value={step.instructions}
        disabled={props.disabled}
        onChange={(instructions) => change((current) => ({ ...current, instructions }))}
      />
      <TextAreaField
        label="Done when"
        rows={2}
        value={step.doneWhen}
        placeholder="The post is live and its link opens."
        disabled={props.disabled}
        hint="The lead checks this before the run moves on, and sends the step back if it isn't true."
        onChange={(doneWhen) => change((current) => ({ ...current, doneWhen }))}
      />
      <div className="flex flex-col gap-1.5">
        <span id={getsId} className="font-medium text-foreground text-sm">
          Gets
        </span>
        {sources.length === 0 && definition.inputs.length === 0 ? (
          <Hint>Nothing yet: it starts as soon as the run does.</Hint>
        ) : (
          <ul aria-labelledby={getsId} className="flex flex-wrap gap-1.5">
            {sources.map((source) => (
              <li key={source.id}>
                <Badge variant="secondary" size="lg">
                  The result of {source.title.trim() || "a step"}
                </Badge>
              </li>
            ))}
            {definition.inputs.map((input, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- inputs have no ids, and a name can be empty or repeat while typed
              <li key={index}>
                <Badge variant="secondary" size="lg">
                  {input.name.trim() || "An input"}, from When
                </Badge>
              </li>
            ))}
          </ul>
        )}
        <Hint>
          A step gets the results of the steps connected into it. It starts when all of them are
          done.
        </Hint>
      </div>
      <p className="rounded-lg bg-muted px-3 py-2.5 text-muted-foreground text-xs">
        When it wants to change something:{" "}
        <span className="text-foreground">{APPROVAL_TITLES[definition.lead.approvals]}</span>, the
        workflow's setting.{" "}
        <InlineButton tone="muted" onClick={() => props.onSelect({ kind: "lead" })}>
          Change it on the lead
        </InlineButton>
      </p>
      <Button
        size="sm"
        variant="ghost-destructive"
        className="mt-auto self-start"
        disabled={props.disabled}
        onClick={() => {
          props.onChange((current) => removeStep(current, step.id));
          props.onSelect(null);
        }}
      >
        <Trash2Icon aria-hidden />
        Remove step
      </Button>
    </>
  );
}
