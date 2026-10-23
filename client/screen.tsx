import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  Icon,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { CREDENTIAL_KEYS, type CredentialKey, credentialsSet, credentialsStatus } from "../shared/credentials.js";
import { type KubeAgentsConfig, kubeSettings } from "../shared/settings.js";

const CREDENTIAL_LABELS: Record<CredentialKey, string> = {
  GH_TOKEN: "GitHub token (GH_TOKEN)",
  CLAUDE_CODE_OAUTH_TOKEN: "Claude OAuth token (CLAUDE_CODE_OAUTH_TOKEN)",
  ANTHROPIC_API_KEY: "Anthropic API key (ANTHROPIC_API_KEY)",
  OPENAI_API_KEY: "OpenAI API key (OPENAI_API_KEY)",
};

export const parseSelector = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split(",")
      .map((pair) => pair.split("=").map((part) => part.trim()))
      .filter((kv): kv is [string, string] => kv.length === 2 && kv[0] !== "" && kv[1] !== ""),
  );

const intOr = (text: string, fallback: number) => {
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) ? n : fallback;
};

function Credential({ name, theme }: { name: CredentialKey; theme: PluginScreenProps["theme"] }) {
  const status = useRpc(credentialsStatus);
  const setCredential = useRpc(credentialsSet);
  const [isSet, setIsSet] = useState<boolean | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void status({}).then((r) => setIsSet(r.set[name] === true), () => setIsSet(null));
  }, [status, name]);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await setCredential({ key: name, value: draft });
      setIsSet(result.set[name] === true);
      setDraft("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [setCredential, name, draft]);

  const stateLabel = isSet === null ? "unknown" : isSet ? "set" : "not set";
  const { colors } = theme;
  return (
    <View style={{ padding: 12, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View accessible accessibilityLabel={stateLabel}>
          <Icon
            name={isSet ? "CircleCheck" : "Circle"}
            size={16}
            color={isSet ? colors.statusSuccess : colors.foregroundMuted}
          />
        </View>
        <Text style={{ color: colors.foreground, flex: 1 }}>{CREDENTIAL_LABELS[name]}</Text>
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
            color: colors.foreground,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: 8,
            paddingHorizontal: 10,
            paddingVertical: 6,
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
      {error ? <Text style={{ color: colors.statusDanger }}>{error}</Text> : null}
    </View>
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

      <SettingsSection title="Credentials">
        <SettingsCard>
          {CREDENTIAL_KEYS.map((key) => (
            <Credential key={key} name={key} theme={theme} />
          ))}
        </SettingsCard>
      </SettingsSection>

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
