import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import * as hostUi from "@getpaseo/plugin/client/ui";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useState } from "react";
import { Linking, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { CREDENTIAL_KEYS, type CredentialKey, credentialsSet, credentialsStatus } from "../shared/credentials.js";
import { type KubeAgentsConfig, kubeSettings } from "../shared/settings.js";

/** Optional host components; older apps may not provide them, so never render an undefined element. */
const optionalUi = hostUi as Partial<{
  ExternalLink: typeof hostUi.ExternalLink;
  copyText: typeof hostUi.copyText;
}>;

function Link({ href, color, children }: { href: string; color: string; children: string }) {
  const HostLink = optionalUi.ExternalLink;
  if (HostLink) return <HostLink href={href}>{children}</HostLink>;
  return (
    <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(href).catch(() => undefined)}>
      <Text style={{ color, textDecorationLine: "underline" }}>{children}</Text>
    </Pressable>
  );
}

/** Plain-View status marker: filled check when set, empty ring when not, dashed when unknown. */
function StatusMark({ state, theme }: { state: boolean | null; theme: PluginScreenProps["theme"] }) {
  const { colors } = theme;
  const color = state ? colors.statusSuccess : colors.foregroundMuted;
  return (
    <View
      accessible
      accessibilityLabel={state === null ? "unknown" : state ? "set" : "not set"}
      style={{
        width: 16,
        height: 16,
        borderRadius: 8,
        borderWidth: 1.5,
        borderColor: color,
        borderStyle: state === null ? "dashed" : "solid",
        backgroundColor: state ? colors.statusSuccess : "transparent",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {state ? <Text style={{ color: colors.surface0, fontSize: 10, lineHeight: 12 }}>✓</Text> : null}
    </View>
  );
}

const CREDENTIAL_LABELS: Record<CredentialKey, string> = {
  GH_TOKEN: "GitHub token (GH_TOKEN)",
  CLAUDE_CODE_OAUTH_TOKEN: "Claude OAuth token (CLAUDE_CODE_OAUTH_TOKEN)",
};

export const parseSelector = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split(",")
      .map((pair) => pair.split("=").map((part) => part.trim()))
      .filter((kv): kv is [string, string] => kv.length === 2 && kv[0] !== "" && kv[1] !== ""),
  );

const CREDENTIAL_HINTS: Record<CredentialKey, { text: string; link?: { href: string; label: string }; command?: string }> = {
  GH_TOKEN: {
    text: "Fine-grained token. Needs Contents and Pull requests read/write, Metadata read.",
    link: { href: "https://github.com/settings/personal-access-tokens/new", label: "Create a token" },
  },
  CLAUDE_CODE_OAUTH_TOKEN: {
    text: "Run on your machine, then paste the token:",
    command: "claude setup-token",
  },
};

const intOr = (text: string, fallback: number) => {
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) ? n : fallback;
};

function Credential({
  name,
  theme,
  isSet,
  statusError,
  onSaved,
}: {
  name: CredentialKey;
  theme: PluginScreenProps["theme"];
  isSet: boolean | null;
  statusError: string | null;
  onSaved(set: Record<string, boolean>): void;
}) {
  const setCredential = useRpc(credentialsSet);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await setCredential({ key: name, value: draft });
      onSaved(result.set);
      setDraft("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [setCredential, name, draft]);

  const { colors } = theme;
  return (
    <View style={{ paddingHorizontal: 14, paddingVertical: 12, gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <StatusMark state={isSet} theme={theme} />
        <Text style={{ color: colors.foreground, flex: 1 }}>{CREDENTIAL_LABELS[name]}</Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 2, paddingLeft: 24 }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{CREDENTIAL_HINTS[name].text}</Text>
        {CREDENTIAL_HINTS[name].command ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <View style={{ backgroundColor: colors.surface2, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
              <Text selectable style={{ color: colors.foreground, fontFamily: "monospace", fontSize: 12 }}>
                {CREDENTIAL_HINTS[name].command}
              </Text>
            </View>
            {optionalUi.copyText ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Copy ${CREDENTIAL_HINTS[name].command}`}
                onPress={() => void optionalUi.copyText!(CREDENTIAL_HINTS[name].command!).catch(() => undefined)}
              >
                <Text style={{ color: colors.accent, fontSize: 12 }}>Copy</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {CREDENTIAL_HINTS[name].link ? (
          <Link href={CREDENTIAL_HINTS[name].link!.href} color={colors.accent}>
            {CREDENTIAL_HINTS[name].link!.label}
          </Link>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy}
          placeholder={isSet ? "New value" : "Value"}
          placeholderTextColor={colors.foregroundMuted}
          accessibilityLabel={`${CREDENTIAL_LABELS[name]} value`}
          style={{
            flex: 1,
            marginLeft: 24,
            color: colors.foreground,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: 8,
            paddingHorizontal: 10,
            paddingVertical: 5,
          }}
        />
        {draft.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Save ${CREDENTIAL_LABELS[name]}`}
            disabled={busy}
            onPress={() => void save()}
            style={{ backgroundColor: colors.accent, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7, opacity: busy ? 0.6 : 1 }}
          >
            <Text style={{ color: colors.accentForeground }}>{busy ? "Saving..." : "Save"}</Text>
          </Pressable>
        ) : null}
      </View>
      {error ? <Text style={{ color: colors.statusDanger, paddingLeft: 24 }}>{error}</Text> : null}
      {statusError ? <Text style={{ color: colors.foregroundMuted, fontSize: 12, paddingLeft: 24 }}>Status unavailable, retrying: {statusError}</Text> : null}
    </View>
  );
}

function CredentialsSection({ theme }: { theme: PluginScreenProps["theme"] }) {
  const status = useRpc(credentialsStatus);
  const [open, setOpen] = useState(false);
  const [set, setSet] = useState<Record<string, boolean> | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    // The plugin can be restarting (update, daemon restart); retry instead of staying unknown.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (attempt: number) => {
      status({}).then(
        (r) => {
          if (cancelled) return;
          setSet(r.set);
          setStatusError(null);
        },
        (e: Error) => {
          if (cancelled) return;
          setStatusError(e.message);
          timer = setTimeout(() => load(attempt + 1), Math.min(30_000, 2_000 * 2 ** attempt));
        },
      );
    };
    load(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { colors } = theme;
  const total = CREDENTIAL_KEYS.length;
  const count = set ? CREDENTIAL_KEYS.filter((k) => set[k] === true).length : null;
  const missing = count !== null && count < total;
  const summary = count === null ? "status unavailable" : missing ? `${count}/${total} set, ${total - count} missing` : `${count}/${total} set`;
  return (
    <>
      <SettingsCard>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={`Credentials, ${summary}`}
          onPress={() => setOpen(!open)}
          style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 12 }}
        >
          <Text style={{ color: colors.foregroundMuted, width: 12 }}>{open ? "▾" : "▸"}</Text>
          <Text style={{ color: missing ? colors.statusWarning : colors.foreground, flex: 1 }}>
            {missing ? "⚠ " : ""}Credentials · {summary}
          </Text>
        </Pressable>
        {open
          ? CREDENTIAL_KEYS.map((key) => (
              <Credential
                key={key}
                name={key}
                theme={theme}
                isSet={set ? set[key] === true : null}
                statusError={statusError}
                onSaved={setSet}
              />
            ))
          : null}
      </SettingsCard>
    </>
  );
}

const NEW_TEMPLATE = { warmPool: { enabled: false, size: 1, idleTimeoutSeconds: 900 } };

function TemplateRow({
  name,
  values,
  update,
}: {
  name: string;
  values: KubeAgentsConfig;
  update: (next: KubeAgentsConfig) => void;
}) {
  const [open, setOpen] = useState(false);
  const template = values.templates[name] ?? NEW_TEMPLATE;
  const setImage = (text: string) =>
    update({
      ...values,
      templates: { ...values.templates, [name]: { ...template, image: text.trim() || undefined } },
    });
  const remove = () => {
    const { [name]: _removed, ...rest } = values.templates;
    update({ ...values, templates: rest });
  };
  return (
    <>
      <SettingsAction
        label={name}
        hint={template.image ?? "default image"}
        actionLabel={open ? "Close" : "Edit"}
        onPress={() => setOpen(!open)}
      />
      {open ? (
        <>
          <SettingsInput label="Image" hint="Empty uses the default image." initialValue={template.image ?? ""} onChangeText={setImage} />
          {name !== "default" ? <SettingsAction label="Remove" actionLabel="Remove" onPress={remove} /> : null}
        </>
      ) : null}
    </>
  );
}

export function KubeAgentsScreen({ theme, layout }: PluginScreenProps) {
  const settings = useSettings(kubeSettings);
  const [draft, setDraft] = useState<KubeAgentsConfig | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    if (settings.status === "ready" && draft === null) {
      setDraft(settings.values);
      setRevision(settings.revision);
    }
  }, [settings, draft]);

  const pad = layout.compact ? 16 : 24;
  const message = (text: string, color: string) => (
    <View style={{ flex: 1, padding: pad, backgroundColor: theme.colors.surface0 }}>
      <Text style={{ color }}>{text}</Text>
    </View>
  );
  if (settings.status === "loading") return message("Loading...", theme.colors.foregroundMuted);
  if (settings.status === "error" || settings.status === "invalid") {
    return message(`Settings unavailable: ${settings.error}`, theme.colors.foreground);
  }
  if (!draft || !revision) return message("Loading...", theme.colors.foregroundMuted);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings.values);
  const names = ["default", ...Object.keys(draft.templates).filter((n) => n !== "default")];
  const name = newName.trim().toLowerCase();
  const nameValid = /^[a-z][a-z0-9-]*$/.test(name) && name !== "default" && !draft.templates[name];
  const addTemplate = () => {
    if (!nameValid) return;
    setDraft({ ...draft, templates: { ...draft.templates, [name]: NEW_TEMPLATE } });
    setNewName("");
    setAdding(false);
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: pad, gap: 16 }}>
      <Text style={{ color: theme.colors.foregroundMuted }}>Runs each agent that picks this provider in its own pod.</Text>

      <SettingsSection title="Cluster">
        <SettingsCard>
          <SettingsInput label="Namespace" initialValue={draft.namespace} onChangeText={(namespace) => setDraft({ ...draft, namespace: namespace.trim() })} />
          <SettingsInput label="Default image" initialValue={draft.defaultImage} onChangeText={(defaultImage) => setDraft({ ...draft, defaultImage: defaultImage.trim() })} />
          <SettingsAction label="Advanced" actionLabel={advanced ? "Hide" : "Show"} onPress={() => setAdvanced(!advanced)} />
          {advanced ? (
            <>
              <SettingsInput label="kubectl context" hint="Empty uses the current context." initialValue={draft.context ?? ""} onChangeText={(t) => setDraft({ ...draft, context: t.trim() || undefined })} />
              <SettingsInput
                label="Node selector"
                hint="label=value, comma separated."
                initialValue={Object.entries(draft.nodeSelector).map(([k, v]) => `${k}=${v}`).join(",")}
                onChangeText={(t) => setDraft({ ...draft, nodeSelector: parseSelector(t) })}
              />
              <SettingsInput
                label="Tolerated taint keys"
                hint="Comma separated."
                initialValue={draft.tolerationKeys.join(",")}
                onChangeText={(t) => setDraft({ ...draft, tolerationKeys: t.split(",").map((k) => k.trim()).filter(Boolean) })}
              />
              <SettingsInput
                label="Agent command"
                hint="ACP agent started in the pod."
                initialValue={draft.agentCommand.join(" ")}
                onChangeText={(t) => {
                  const parts = t.split(/\s+/).filter(Boolean);
                  if (parts.length > 0) setDraft({ ...draft, agentCommand: parts });
                }}
              />
            </>
          ) : null}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Templates" info="Pick one on an agent with PASEO_KUBE_TEMPLATE.">
        <SettingsCard>
          {names.map((n) => (
            <TemplateRow key={n} name={n} values={draft} update={setDraft} />
          ))}
          {adding ? (
            <>
              <SettingsInput label="Name" hint="Lowercase letters, digits and dashes." placeholder="go" onChangeText={setNewName} />
              <SettingsAction label="" actionLabel="Add" onPress={addTemplate} disabled={!nameValid} />
            </>
          ) : (
            <SettingsAction label="Add template" actionLabel="Add" onPress={() => setAdding(true)} />
          )}
        </SettingsCard>
      </SettingsSection>

      <CredentialsSection theme={theme} />

      <SettingsCard>
        <SettingsAction
          label={settings.saveError ? "Not saved" : dirty ? "Unsaved changes" : "Saved"}
          hint={settings.saveError ?? undefined}
          actionLabel={settings.saving ? "Saving..." : "Save"}
          disabled={!dirty || settings.saving}
          onPress={() => {
            void settings.save(draft, revision).then((ok) => {
              if (ok) setDraft(null);
            });
          }}
        />
      </SettingsCard>
    </ScrollView>
  );
}
