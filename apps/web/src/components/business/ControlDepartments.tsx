import {
  CONTROL_PROFILE_TEMPLATES,
  type ControlDepartment,
  type ControlPerson,
  ControlProfileTemplateName,
  type ControlTeam,
} from "@codenine/contracts/control";
import React, { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { type ControlCall, SectionTitle } from "./adminParts";

const templateNames = ControlProfileTemplateName.literals;

/** Departments and their teams, as far as the signed-in person's role reaches. */
export function DepartmentsSection({
  departments,
  people,
  canCreate,
  onAction,
}: {
  readonly departments: ReadonlyArray<ControlDepartment>;
  /** The people the signed-in person can add. */
  readonly people: ReadonlyArray<ControlPerson>;
  /** Owners and admins create, rename and delete departments. */
  readonly canCreate: boolean;
  readonly onAction: (change: ControlCall) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<ControlProfileTemplateName | "">("");
  const byId = new Map(people.map((person) => [person.id, person]));

  return (
    <section>
      <SectionTitle>Departments</SectionTitle>
      <p className="mt-2 text-sm text-muted-foreground">
        People can be in several departments. Teams group people within one.
      </p>
      <div className="mt-3 space-y-3">
        {departments.map((department) => (
          <DepartmentCard
            byId={byId}
            canCreate={canCreate}
            department={department}
            key={department.id}
            onAction={onAction}
            people={people}
          />
        ))}
      </div>
      {departments.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">No departments yet.</p>
      ) : null}
      {canCreate ? (
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void onAction((client) =>
              client.admin.createDepartment({
                payload: template === "" ? { name } : { name, template },
              }),
            ).then((created) => {
              if (created) {
                setName("");
                setTemplate("");
              }
            });
          }}
        >
          <div className="w-56">
            <Input
              aria-label="Department name"
              nativeInput
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder="Engineering"
              value={name}
            />
          </div>
          <Select
            items={{
              "": "No template",
              ...Object.fromEntries(templateNames.map((option) => [option, option])),
            }}
            onValueChange={(value) => {
              const chosen = templateNames.find((option) => option === value);
              setTemplate(chosen ?? "");
            }}
            value={template}
          >
            <SelectTrigger aria-label="Start from a template" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="">No template</SelectItem>
              {templateNames.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}: {CONTROL_PROFILE_TEMPLATES[option].description}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Button disabled={name.trim() === ""} size="sm" type="submit" variant="outline">
            Add department
          </Button>
        </form>
      ) : null}
    </section>
  );
}

function DepartmentCard({
  department,
  people,
  byId,
  canCreate,
  onAction,
}: {
  readonly department: ControlDepartment;
  readonly people: ReadonlyArray<ControlPerson>;
  readonly byId: ReadonlyMap<string, ControlPerson>;
  readonly canCreate: boolean;
  readonly onAction: (change: ControlCall) => Promise<boolean>;
}) {
  const [teamName, setTeamName] = useState("");
  const departmentId = department.id;
  const outside = people.filter((person) => !department.members.includes(person.id));
  const label = (personId: string) => byId.get(personId)?.displayName ?? personId;

  return (
    <div className="rounded-lg border border-border/70 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Renamable
          label="Department name"
          name={department.name}
          onRename={
            canCreate
              ? (name) =>
                  onAction((client) =>
                    client.admin.renameDepartment({ params: { departmentId }, payload: { name } }),
                  )
              : null
          }
        />
        <Badge variant="secondary">
          {department.members.length} {department.members.length === 1 ? "person" : "people"}
        </Badge>
        {canCreate && department.members.length === 0 ? (
          <Button
            onClick={() =>
              void onAction((client) => client.admin.deleteDepartment({ params: { departmentId } }))
            }
            size="xs"
            variant="destructive-outline"
          >
            Delete
          </Button>
        ) : null}
      </div>
      <Members
        add={{
          candidates: outside,
          label: `Add someone to ${department.name}`,
          onAdd: (personId) =>
            onAction((client) =>
              client.admin.addDepartmentMember({ params: { departmentId, personId } }),
            ),
        }}
        label={label}
        members={department.members}
        onRemove={(personId) =>
          onAction((client) =>
            client.admin.removeDepartmentMember({ params: { departmentId, personId } }),
          )
        }
      />
      {department.teams.map((team) => (
        <TeamRow
          department={department}
          key={team.id}
          label={label}
          onAction={onAction}
          byId={byId}
          team={team}
        />
      ))}
      <form
        className="mt-2 flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void onAction((client) =>
            client.admin.createTeam({ params: { departmentId }, payload: { name: teamName } }),
          ).then((created) => {
            if (created) setTeamName("");
          });
        }}
      >
        <div className="w-48">
          <Input
            aria-label={`New team in ${department.name}`}
            nativeInput
            onChange={(event) => setTeamName(event.currentTarget.value)}
            placeholder="New team"
            size="sm"
            value={teamName}
          />
        </div>
        <Button disabled={teamName.trim() === ""} size="xs" type="submit" variant="outline">
          Add team
        </Button>
      </form>
    </div>
  );
}

function TeamRow({
  department,
  team,
  byId,
  label,
  onAction,
}: {
  readonly department: ControlDepartment;
  readonly team: ControlTeam;
  readonly byId: ReadonlyMap<string, ControlPerson>;
  readonly label: (personId: string) => string;
  readonly onAction: (change: ControlCall) => Promise<boolean>;
}) {
  const teamId = team.id;
  const candidates = department.members
    .filter((personId) => !team.members.includes(personId))
    .flatMap((personId) => {
      const person = byId.get(personId);
      return person === undefined ? [] : [person];
    });
  return (
    <div className="mt-2 border-l-2 border-border/70 pl-3">
      <div className="flex flex-wrap items-center gap-2">
        <Renamable
          label="Team name"
          name={team.name}
          onRename={(name) =>
            onAction((client) => client.admin.renameTeam({ params: { teamId }, payload: { name } }))
          }
        />
        <Button
          onClick={() => void onAction((client) => client.admin.deleteTeam({ params: { teamId } }))}
          size="xs"
          variant="ghost"
        >
          Delete team
        </Button>
      </div>
      <Members
        add={{
          candidates,
          label: `Add someone to ${team.name}`,
          onAdd: (personId) =>
            onAction((client) => client.admin.addTeamMember({ params: { teamId, personId } })),
        }}
        label={label}
        members={team.members}
        onRemove={(personId) =>
          onAction((client) => client.admin.removeTeamMember({ params: { teamId, personId } }))
        }
      />
    </div>
  );
}

function Members({
  members,
  label,
  onRemove,
  add,
}: {
  readonly members: ReadonlyArray<string>;
  readonly label: (personId: string) => string;
  readonly onRemove: (personId: string) => Promise<boolean>;
  readonly add: {
    readonly candidates: ReadonlyArray<ControlPerson>;
    readonly label: string;
    readonly onAdd: (personId: string) => Promise<boolean>;
  };
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {members.map((personId) => (
        <Button
          aria-label={`Remove ${label(personId)}`}
          key={personId}
          onClick={() => void onRemove(personId)}
          size="xs"
          variant="outline"
        >
          {label(personId)} ×
        </Button>
      ))}
      {add.candidates.length === 0 ? null : (
        <div className="w-48">
          <Select
            items={Object.fromEntries(
              add.candidates.map((person) => [person.id, person.displayName]),
            )}
            onValueChange={(value) => {
              const chosen = add.candidates.find((person) => person.id === value);
              if (chosen !== undefined) void add.onAdd(chosen.id);
            }}
            value={null}
          >
            <SelectTrigger aria-label={add.label} size="xs">
              <SelectValue placeholder="Add someone" />
            </SelectTrigger>
            <SelectPopup>
              {add.candidates.map((person) => (
                <SelectItem key={person.id} value={person.id}>
                  {person.displayName}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      )}
    </div>
  );
}

/** A name, with a way to change it when `onRename` is given. */
function Renamable({
  name,
  label,
  onRename,
}: {
  readonly name: string;
  readonly label: string;
  readonly onRename: ((name: string) => Promise<boolean>) | null;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) {
    return (
      <>
        <p className="text-sm font-medium">{name}</p>
        {onRename === null ? null : (
          <Button onClick={() => setDraft(name)} size="xs" variant="ghost">
            Rename
          </Button>
        )}
      </>
    );
  }
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event: React.SubmitEvent<HTMLFormElement>) => {
        event.preventDefault();
        void onRename?.(draft).then((renamed) => {
          if (renamed) setDraft(null);
        });
      }}
    >
      <div className="w-48">
        <Input
          aria-label={label}
          autoFocus
          nativeInput
          onChange={(event) => setDraft(event.currentTarget.value)}
          size="sm"
          value={draft}
        />
      </div>
      <Button size="xs" type="submit">
        Save
      </Button>
      <Button onClick={() => setDraft(null)} size="xs" variant="ghost">
        Cancel
      </Button>
    </form>
  );
}
