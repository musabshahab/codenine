import type {
  ControlAiEffort,
  ControlDepartment,
  ControlPerson,
  ControlProfile,
  ControlProfileException,
  ControlProfilePreview,
  ControlProfileScalar,
  ControlProfileSettings,
} from "@codenine/contracts/control";
import React, { useState } from "react";

import { callControl, controlErrorMessage } from "../../business/control";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { type ControlCall, SectionTitle } from "./adminParts";

interface Draft {
  readonly image: string;
  readonly cpus: string;
  readonly memoryGb: string;
  readonly sleepMinutes: string;
  readonly blockTerminal: boolean;
  /** One host a line; a leading dot covers a domain and everything under it. */
  readonly allowHosts: string;
  readonly blockHosts: string;
  /** One model a line; empty for any. */
  readonly claudeModels: string;
  readonly codexModels: string;
  readonly effort: ControlAiEffort | "any";
  /** Dollars, as typed. */
  readonly monthlyUsd: string;
  readonly dailyUsd: string;
  /** The company's profile only. */
  readonly companyMonthlyUsd: string;
  readonly departmentMonthlyUsd: Readonly<Record<string, string>>;
  readonly lock: ReadonlyArray<ControlProfileScalar>;
}

const LOCKABLE: ReadonlyArray<readonly [ControlProfileScalar, string]> = [
  ["image", "Image"],
  ["cpus", "CPUs"],
  ["memoryGb", "Memory"],
  ["sleepMinutes", "Sleep"],
  ["claudeModels", "Claude models"],
  ["codexModels", "Codex models"],
  ["effort", "Effort"],
  ["monthlyUsd", "Monthly budget"],
  ["dailyUsd", "Daily budget"],
];

const EFFORTS: Record<ControlAiEffort | "any", string> = {
  any: "Any effort",
  low: "Effort up to low",
  medium: "Effort up to medium",
  high: "Effort up to high",
  xhigh: "Effort up to extra high",
  max: "Effort up to max",
};

const SETTING_NAMES: Record<string, string> = {
  image: "Image",
  cpus: "CPUs",
  memoryGb: "Memory (GB)",
  sleepMinutes: "Sleep after (minutes)",
  terminal: "Terminal",
  allowHosts: "Allowed sites",
  blockHosts: "Blocked sites",
  claudeModels: "Claude models",
  codexModels: "Codex models",
  effort: "Highest effort",
  monthlyUsd: "Monthly AI budget",
  dailyUsd: "Daily AI budget",
  departmentMonthlyUsd: "Department's AI budget",
  companyMonthlyUsd: "Company's AI budget",
};

const HOST = /^\.?[a-z0-9-]+(\.[a-z0-9-]+)+$/u;
const MODEL = /^[a-z0-9][\w.:@/-]*$/u;

const lines = (values: ReadonlyArray<string> | undefined) => (values ?? []).join("\n");
const amount = (value: number | undefined) => (value === undefined ? "" : String(value));

const draftOf = (settings: ControlProfileSettings): Draft => ({
  image: settings.image ?? "",
  cpus: settings.cpus === undefined ? "" : String(settings.cpus),
  memoryGb: settings.memoryGb === undefined ? "" : String(settings.memoryGb),
  sleepMinutes: settings.sleepMinutes === undefined ? "" : String(settings.sleepMinutes),
  blockTerminal: settings.terminal === "block",
  allowHosts: (settings.allowHosts ?? []).join("\n"),
  blockHosts: (settings.blockHosts ?? []).join("\n"),
  claudeModels: lines(settings.claudeModels),
  codexModels: lines(settings.codexModels),
  effort: settings.effort ?? "any",
  monthlyUsd: amount(settings.monthlyUsd),
  dailyUsd: amount(settings.dailyUsd),
  companyMonthlyUsd: amount(settings.companyMonthlyUsd),
  departmentMonthlyUsd: Object.fromEntries(
    Object.entries(settings.departmentMonthlyUsd ?? {}).map(([id, usd]) => [id, String(usd)]),
  ),
  lock: settings.lock ?? [],
});

/** The settings a draft makes, or what is wrong with it. Empty fields leave the layers above. */
const settingsOf = (draft: Draft): ControlProfileSettings | string => {
  const number = (text: string, name: string) => {
    if (text.trim() === "") return undefined;
    const value = Number(text);
    return Number.isFinite(value) && value > 0 ? value : `${name} must be a number above 0.`;
  };
  const hosts = (text: string) =>
    text
      .split(/[\s,]+/u)
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host !== "");
  const cpus = number(draft.cpus, "CPUs");
  const memoryGb = number(draft.memoryGb, "Memory");
  const sleepMinutes = number(draft.sleepMinutes, "Sleep");
  for (const value of [cpus, memoryGb, sleepMinutes]) if (typeof value === "string") return value;
  const allowHosts = hosts(draft.allowHosts);
  const blockHosts = hosts(draft.blockHosts);
  const wrong = [...allowHosts, ...blockHosts].find((host) => !HOST.test(host));
  if (wrong !== undefined) {
    return `${wrong} is not a host name. Write one like git.acme.com, or .acme.com for a whole domain.`;
  }
  const claudeModels = hosts(draft.claudeModels);
  const codexModels = hosts(draft.codexModels);
  const odd = [...claudeModels, ...codexModels].find((model) => !MODEL.test(model));
  if (odd !== undefined) {
    return `${odd} is not a model name. Write one as the provider names it, such as claude-opus-5-5.`;
  }
  const dollars = (text: string, name: string) => {
    if (text.trim() === "") return undefined;
    const value = Number(text.trim().replace(/^\$/u, ""));
    return Number.isFinite(value) && value >= 0
      ? Math.round(value * 100) / 100
      : `${name} must be an amount in dollars.`;
  };
  const monthlyUsd = dollars(draft.monthlyUsd, "The monthly budget");
  const dailyUsd = dollars(draft.dailyUsd, "The daily budget");
  const companyMonthlyUsd = dollars(draft.companyMonthlyUsd, "The company's budget");
  const departmentMonthlyUsd: Record<string, number> = {};
  for (const [id, text] of Object.entries(draft.departmentMonthlyUsd)) {
    const value = dollars(text, "A department's budget");
    if (typeof value === "string") return value;
    if (value !== undefined) departmentMonthlyUsd[id] = value;
  }
  for (const value of [monthlyUsd, dailyUsd, companyMonthlyUsd]) {
    if (typeof value === "string") return value;
  }
  return {
    ...(draft.image.trim() === "" ? {} : { image: draft.image.trim() }),
    ...(typeof cpus === "number" ? { cpus } : {}),
    ...(typeof memoryGb === "number" ? { memoryGb } : {}),
    ...(typeof sleepMinutes === "number" ? { sleepMinutes: Math.round(sleepMinutes) } : {}),
    ...(draft.blockTerminal ? { terminal: "block" as const } : {}),
    ...(allowHosts.length === 0 ? {} : { allowHosts }),
    ...(blockHosts.length === 0 ? {} : { blockHosts }),
    ...(claudeModels.length === 0 ? {} : { claudeModels }),
    ...(codexModels.length === 0 ? {} : { codexModels }),
    ...(draft.effort === "any" ? {} : { effort: draft.effort }),
    ...(typeof monthlyUsd === "number" ? { monthlyUsd } : {}),
    ...(typeof dailyUsd === "number" ? { dailyUsd } : {}),
    ...(typeof companyMonthlyUsd === "number" ? { companyMonthlyUsd } : {}),
    ...(Object.keys(departmentMonthlyUsd).length === 0 ? {} : { departmentMonthlyUsd }),
    ...(draft.lock.length === 0 ? {} : { lock: [...draft.lock] }),
  };
};

/** One line for a layer's settings, as the history and exceptions show them. */
const describe = (
  settings: ControlProfileSettings,
  departmentName: (id: string) => string = (id) => id,
) =>
  [
    settings.image === undefined ? null : `image ${settings.image}`,
    settings.cpus === undefined ? null : `${settings.cpus} CPUs`,
    settings.memoryGb === undefined ? null : `${settings.memoryGb} GB`,
    settings.sleepMinutes === undefined ? null : `sleeps after ${settings.sleepMinutes} min`,
    settings.terminal === "block" ? "no terminal" : null,
    settings.allowHosts === undefined ? null : `allows ${settings.allowHosts.join(", ")}`,
    settings.blockHosts === undefined ? null : `blocks ${settings.blockHosts.join(", ")}`,
    settings.claudeModels === undefined ? null : `Claude on ${settings.claudeModels.join(", ")}`,
    settings.codexModels === undefined ? null : `Codex on ${settings.codexModels.join(", ")}`,
    settings.effort === undefined ? null : `effort up to ${settings.effort}`,
    settings.monthlyUsd === undefined ? null : `$${settings.monthlyUsd} a month each`,
    settings.dailyUsd === undefined ? null : `$${settings.dailyUsd} a day each`,
    settings.companyMonthlyUsd === undefined
      ? null
      : `$${settings.companyMonthlyUsd} a month for everyone`,
    settings.departmentMonthlyUsd === undefined
      ? null
      : Object.entries(settings.departmentMonthlyUsd)
          .map(([id, usd]) => `$${usd} a month for ${departmentName(id)}`)
          .join(", "),
    settings.lock === undefined ? null : `locks ${settings.lock.join(", ")}`,
  ]
    .filter((part) => part !== null)
    .join(" · ") || "nothing of its own";

/** An amount in dollars with its name beside it, so it reads the same once filled in. */
function DollarField({
  label,
  name = label,
  value,
  placeholder,
  onChange,
}: {
  readonly label: string;
  /** What assistive technology reads, where the label leans on a heading. */
  readonly name?: string;
  readonly value: string;
  readonly placeholder: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{label}</span>
      <div className="w-28 shrink-0">
        <Input
          aria-label={name}
          inputMode="decimal"
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder={placeholder}
          size="sm"
          value={value}
        />
      </div>
    </label>
  );
}

function SettingsFields({
  draft,
  onChange,
  withLocks,
  sharedBudgets,
}: {
  readonly draft: Draft;
  readonly onChange: (next: Partial<Draft>) => void;
  readonly withLocks: boolean;
  /** On the company's profile, the departments whose shared budgets it sets. */
  readonly sharedBudgets: ReadonlyArray<ControlDepartment> | null;
}) {
  const number = (key: "cpus" | "memoryGb" | "sleepMinutes", label: string) => (
    <Input
      aria-label={label}
      inputMode="decimal"
      onChange={(event) => onChange({ [key]: event.currentTarget.value })}
      placeholder={label}
      size="sm"
      value={draft[key]}
    />
  );
  return (
    <div className="space-y-2">
      <Input
        aria-label="Image"
        onChange={(event) => onChange({ image: event.currentTarget.value })}
        placeholder="Image, such as registry.acme.com/codenine-workspace:design"
        size="sm"
        value={draft.image}
      />
      <div className="grid grid-cols-3 gap-2">
        {number("cpus", "CPUs")}
        {number("memoryGb", "Memory (GB)")}
        {number("sleepMinutes", "Sleep after (minutes)")}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Textarea
          aria-label="Allowed sites"
          onChange={(event) => onChange({ allowHosts: event.currentTarget.value })}
          placeholder={"Sites it may reach, one a line, such as\n.figma.com"}
          size="sm"
          spellCheck={false}
          value={draft.allowHosts}
        />
        <Textarea
          aria-label="Blocked sites"
          onChange={(event) => onChange({ blockHosts: event.currentTarget.value })}
          placeholder={"Sites it may not reach, one a line, such as\n.github.com"}
          size="sm"
          spellCheck={false}
          value={draft.blockHosts}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={draft.blockTerminal}
          onCheckedChange={(checked) => onChange({ blockTerminal: checked === true })}
        />
        Block the terminal
      </label>
      <p className="pt-1 text-sm font-medium">AI</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Textarea
          aria-label="Claude models"
          onChange={(event) => onChange({ claudeModels: event.currentTarget.value })}
          placeholder={"The only Claude models allowed, one a line, such as\nclaude-opus-5-5"}
          size="sm"
          spellCheck={false}
          value={draft.claudeModels}
        />
        <Textarea
          aria-label="Codex models"
          onChange={(event) => onChange({ codexModels: event.currentTarget.value })}
          placeholder={"The only Codex models allowed, one a line, such as\ngpt-5.5"}
          size="sm"
          spellCheck={false}
          value={draft.codexModels}
        />
      </div>
      <Select
        items={EFFORTS}
        onValueChange={(value) => {
          if (typeof value === "string" && value in EFFORTS) {
            onChange({ effort: value as Draft["effort"] });
          }
        }}
        value={draft.effort}
      >
        <SelectTrigger aria-label="Highest effort" size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {Object.entries(EFFORTS).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <DollarField
        label="Each person, $ a month"
        onChange={(monthlyUsd) => onChange({ monthlyUsd })}
        placeholder="Not set"
        value={draft.monthlyUsd}
      />
      <DollarField
        label="Each person, $ a day"
        onChange={(dailyUsd) => onChange({ dailyUsd })}
        placeholder="Not set"
        value={draft.dailyUsd}
      />
      {sharedBudgets === null ? null : (
        <>
          <p className="pt-1 text-sm">Spent together, $ a month</p>
          <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
            <DollarField
              label="Everyone"
              name="Everyone together, $ a month"
              onChange={(companyMonthlyUsd) => onChange({ companyMonthlyUsd })}
              placeholder="No limit"
              value={draft.companyMonthlyUsd}
            />
            {sharedBudgets.map((department) => (
              <DollarField
                key={department.id}
                label={department.name}
                name={`${department.name} together, $ a month`}
                onChange={(usd) =>
                  onChange({
                    departmentMonthlyUsd: { ...draft.departmentMonthlyUsd, [department.id]: usd },
                  })
                }
                placeholder="No limit"
                value={draft.departmentMonthlyUsd[department.id] ?? ""}
              />
            ))}
          </div>
        </>
      )}
      {withLocks ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-muted-foreground">Layers below cannot change:</span>
          {LOCKABLE.map(([key, label]) => (
            <label className="flex items-center gap-1.5" key={key}>
              <Checkbox
                aria-label={`Lock ${label}`}
                checked={draft.lock.includes(key)}
                onCheckedChange={(checked) =>
                  onChange({
                    lock:
                      checked === true
                        ? [...draft.lock, key]
                        : draft.lock.filter((locked) => locked !== key),
                  })
                }
              />
              {label}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Workspace profiles as far as the signed-in person's role reaches, and people's exceptions. */
export function ProfilesSection({
  profiles,
  exceptions,
  people,
  departments,
  onAction,
}: {
  readonly profiles: ReadonlyArray<ControlProfile>;
  readonly exceptions: ReadonlyArray<ControlProfileException>;
  readonly people: ReadonlyArray<ControlPerson>;
  readonly departments: ReadonlyArray<ControlDepartment>;
  readonly onAction: (change: ControlCall) => Promise<boolean>;
}) {
  const [chosenId, setChosenId] = useState(profiles[0]?.id ?? "");
  const chosen = profiles.find((profile) => profile.id === chosenId) ?? profiles[0];
  const current = chosen?.versions.find((version) => version.version === chosen.published);
  const [draft, setDraft] = useState<Draft>(() => draftOf(current?.settings ?? {}));
  const [note, setNote] = useState("");
  const [testers, setTesters] = useState("");
  const [preview, setPreview] = useState<ControlProfilePreview | null>(null);
  const [problem, setProblem] = useState("");
  const byId = new Map(people.map((person) => [person.id, person]));
  const nameOf = (personId: string) => byId.get(personId)?.displayName ?? personId;
  const departmentName = (id: string) =>
    departments.find((department) => department.id === id)?.name ?? id;

  const choose = (id: string) => {
    const profile = profiles.find((candidate) => candidate.id === id);
    setChosenId(id);
    setDraft(
      draftOf(
        profile?.versions.find((version) => version.version === profile.published)?.settings ?? {},
      ),
    );
    setPreview(null);
    setProblem("");
  };

  if (chosen === undefined) return null;
  const settings = settingsOf(draft);
  const change = (next: Partial<Draft>) => {
    setDraft((before) => ({ ...before, ...next }));
    setPreview(null);
  };

  const showPreview = async () => {
    if (typeof settings === "string") return setProblem(settings);
    setProblem("");
    await callControl((client) =>
      client.admin.previewProfile({ params: { profileId: chosen.id }, payload: { settings } }),
    ).then(setPreview, (error: unknown) => setProblem(controlErrorMessage(error)));
  };

  const save = async (tryFirst: boolean) => {
    if (typeof settings === "string") return setProblem(settings);
    const emails = testers
      .split(/[\s,]+/u)
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email !== "");
    const testWith = people
      .filter((person) => emails.includes(person.email.toLowerCase()))
      .map((person) => person.id);
    if (tryFirst && testWith.length !== emails.length) {
      return setProblem("Name the people to try it on by the email addresses they use here.");
    }
    setProblem("");
    if (
      await onAction((client) =>
        client.admin.saveProfile({
          params: { profileId: chosen.id },
          payload: { settings, note, ...(tryFirst ? { testWith } : {}) },
        }),
      )
    ) {
      setNote("");
      setTesters("");
      setPreview(null);
    }
  };

  return (
    <section>
      <SectionTitle>Workspace profiles</SectionTitle>
      <p className="mt-2 text-sm text-muted-foreground">
        Workspaces are made from the company's profile, then their department's, then their teams'.
        A layer cannot change what one above locked, lift a blocked terminal, or allow a site one
        above blocked. A new size or image reaches each workspace when it next starts; AI rules and
        budgets apply to calls within a minute. Budgets are in US dollars, the company's and each
        department's set on the company's profile.
      </p>
      <div className="mt-3 w-64">
        <Select
          items={Object.fromEntries(profiles.map((profile) => [profile.id, profile.name]))}
          onValueChange={(value) => {
            if (typeof value === "string") choose(value);
          }}
          value={chosen.id}
        >
          <SelectTrigger aria-label="Profile" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {profiles.map((profile) => (
              <SelectItem key={profile.id} value={profile.id}>
                {profile.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      {chosen.test === null ? null : (
        <Alert className="mt-3" variant="info">
          <AlertDescription>
            <p>
              Version {chosen.test.version} is being tried by{" "}
              {chosen.test.people.map(nameOf).join(", ")}.
            </p>
            <div className="mt-2 flex gap-2">
              <Button
                onClick={() =>
                  void onAction((client) =>
                    client.admin.publishTest({ params: { profileId: chosen.id } }),
                  )
                }
                size="xs"
                variant="outline"
              >
                Give it to everyone
              </Button>
              <Button
                onClick={() =>
                  void onAction((client) =>
                    client.admin.discardTest({ params: { profileId: chosen.id } }),
                  )
                }
                size="xs"
                variant="ghost"
              >
                Drop it
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      <form
        className="mt-3 space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save(false);
        }}
      >
        <SettingsFields
          draft={draft}
          onChange={change}
          sharedBudgets={chosen.id === "company" ? departments : null}
          withLocks
        />
        <Input
          aria-label="What changed"
          onChange={(event) => setNote(event.currentTarget.value)}
          placeholder="What changed, for the history (optional)"
          size="sm"
          value={note}
        />
        <Input
          aria-label="Try it first on"
          onChange={(event) => setTesters(event.currentTarget.value)}
          placeholder="Try it first on these email addresses (optional)"
          size="sm"
          value={testers}
        />
        {preview === null ? null : (
          <Alert variant={preview.affected === 0 ? "info" : "warning"}>
            <AlertDescription>
              {preview.affected === 0
                ? `It changes nothing for the ${preview.people} people it reaches.`
                : `It changes what ${preview.affected} of ${preview.people} people get: ${preview.changes
                    .map(
                      (changed) =>
                        `${SETTING_NAMES[changed.setting] ?? changed.setting} for ${changed.people} (${[
                          ...changed.removed.map((value) => `−${value}`),
                          ...changed.added.map((value) => `+${value}`),
                        ].join(", ")})`,
                    )
                    .join("; ")}.`}
            </AlertDescription>
          </Alert>
        )}
        {problem ? (
          <Alert variant="error">
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void showPreview()} size="sm" variant="outline">
            Preview
          </Button>
          <Button size="sm" type="submit">
            Give it to everyone
          </Button>
          <Button
            disabled={testers.trim() === ""}
            onClick={() => void save(true)}
            size="sm"
            variant="outline"
          >
            Try it first
          </Button>
        </div>
      </form>

      <p className="mt-5 text-sm font-medium">History</p>
      <ul className="mt-1 divide-y divide-border/70">
        {chosen.versions.map((version) => (
          <li className="py-1.5 text-xs" key={version.version}>
            <span className="font-medium">Version {version.version}</span>{" "}
            {version.version === chosen.published ? (
              <Badge variant="success">Everyone</Badge>
            ) : null}
            {version.version === chosen.test?.version ? (
              <Badge variant="info">Being tried</Badge>
            ) : null}
            <span className="text-muted-foreground">
              {" "}
              · {describe(version.settings, departmentName)} · {version.createdBy},{" "}
              {new Date(version.createdAt).toLocaleString()}
              {version.note === "" ? "" : ` · ${version.note}`}
            </span>
          </li>
        ))}
      </ul>
      {chosen.versions.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">No versions yet.</p>
      ) : chosen.versions.length === 1 ? null : (
        <Button
          className="mt-2"
          onClick={() =>
            void onAction((client) =>
              client.admin.rollBackProfile({ params: { profileId: chosen.id } }),
            )
          }
          size="xs"
          variant="outline"
        >
          Roll back to the version before
        </Button>
      )}

      <ExceptionsPart
        departments={departments}
        exceptions={exceptions}
        nameOf={nameOf}
        onAction={onAction}
        people={people}
      />
    </section>
  );
}

const EXCEPTION_DAYS = 90;

function ExceptionsPart({
  exceptions,
  people,
  departments,
  nameOf,
  onAction,
}: {
  readonly exceptions: ReadonlyArray<ControlProfileException>;
  readonly people: ReadonlyArray<ControlPerson>;
  readonly departments: ReadonlyArray<ControlDepartment>;
  readonly nameOf: (personId: string) => string;
  readonly onAction: (change: ControlCall) => Promise<boolean>;
}) {
  const [personId, setPersonId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [draft, setDraft] = useState<Draft>(() => draftOf({}));
  const [reason, setReason] = useState("");
  const [days, setDays] = useState("7");
  const [problem, setProblem] = useState("");
  const theirs = departments.filter((department) => department.members.includes(personId));
  const departmentName = (id: string | null) =>
    id === null ? "every department" : (departments.find((d) => d.id === id)?.name ?? id);

  const add = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const settings = settingsOf(draft);
    const lasting = Number(days);
    if (typeof settings === "string") return setProblem(settings);
    if (!Number.isInteger(lasting) || lasting < 1 || lasting > EXCEPTION_DAYS) {
      return setProblem(`An exception lasts from 1 to ${EXCEPTION_DAYS} days.`);
    }
    setProblem("");
    const endsAt = new Date(Date.now() + lasting * 24 * 60 * 60 * 1000).toISOString();
    if (
      await onAction((client) =>
        client.admin.addException({
          payload: {
            personId,
            departmentId: departmentId === "" ? null : departmentId,
            settings,
            reason,
            endsAt,
          },
        }),
      )
    ) {
      setDraft(draftOf({}));
      setReason("");
    }
  };

  return (
    <>
      <p className="mt-6 text-sm font-medium">Exceptions</p>
      <p className="mt-1 text-sm text-muted-foreground">
        One person's settings for a while, on top of every layer, and within what they lock or
        block.
      </p>
      <ul className="mt-2 divide-y divide-border/70">
        {exceptions.map((exception) => (
          <li className="flex flex-wrap items-center gap-2 py-1.5 text-xs" key={exception.id}>
            <span className="min-w-0 flex-1">
              <span className="font-medium">{nameOf(exception.personId)}</span> in{" "}
              {departmentName(exception.departmentId)} · {describe(exception.settings)} ·{" "}
              {exception.reason} · until {new Date(exception.endsAt).toLocaleDateString()}
            </span>
            <Button
              onClick={() =>
                void onAction((client) =>
                  client.admin.endException({ params: { exceptionId: exception.id } }),
                )
              }
              size="xs"
              variant="outline"
            >
              End
            </Button>
          </li>
        ))}
      </ul>
      {exceptions.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">None now.</p>
      ) : null}

      <form className="mt-3 space-y-2" onSubmit={(event) => void add(event)}>
        <div className="flex flex-wrap gap-2">
          <div className="w-56">
            <Select
              items={Object.fromEntries(people.map((person) => [person.id, person.displayName]))}
              onValueChange={(value) => {
                if (typeof value !== "string") return;
                setPersonId(value);
                setDepartmentId("");
              }}
              value={personId}
            >
              <SelectTrigger aria-label="Person" size="sm">
                <SelectValue placeholder="Person" />
              </SelectTrigger>
              <SelectPopup>
                {people.map((person) => (
                  <SelectItem key={person.id} value={person.id}>
                    {person.displayName}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <div className="w-56">
            <Select
              items={{
                "": "Every department",
                ...Object.fromEntries(theirs.map((department) => [department.id, department.name])),
              }}
              onValueChange={(value) => setDepartmentId(typeof value === "string" ? value : "")}
              value={departmentId}
            >
              <SelectTrigger aria-label="Department of the exception" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="">Every department</SelectItem>
                {theirs.map((department) => (
                  <SelectItem key={department.id} value={department.id}>
                    {department.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        </div>
        <SettingsFields
          draft={draft}
          onChange={(next) => setDraft((before) => ({ ...before, ...next }))}
          sharedBudgets={null}
          withLocks={false}
        />
        <div className="flex flex-wrap gap-2">
          <div className="min-w-48 flex-1">
            <Input
              aria-label="Reason"
              onChange={(event) => setReason(event.currentTarget.value)}
              placeholder="Why, for the audit log"
              size="sm"
              value={reason}
            />
          </div>
          <div className="w-32">
            <Input
              aria-label="Days it lasts"
              inputMode="numeric"
              onChange={(event) => setDays(event.currentTarget.value)}
              size="sm"
              value={days}
            />
          </div>
        </div>
        {problem ? (
          <Alert variant="error">
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        ) : null}
        <Button disabled={personId === "" || reason.trim() === ""} size="sm" type="submit">
          Make the exception
        </Button>
      </form>
    </>
  );
}
