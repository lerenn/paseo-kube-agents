import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { CREDENTIAL_KEYS, type CredentialKey, credentialsSet, credentialsStatus } from "../shared/credentials.js";
import { type KubeAgentsConfig, kubeSettings } from "../shared/settings.js";

const CREDENTIAL_LABELS: Record<CredentialKey, string> = {
  GH_TOKEN: "GitHub token (GH_TOKEN)",
  CLAUDE_CODE_OAUTH_TOKEN: "Claude OAuth token (CLAUDE_CODE_OAUTH_TOKEN)",
  ANTHROPIC_API_KEY: "Anthropic API key (ANTHROPIC_API_KEY)",
  OPENAI_API_KEY: "OpenAI API key (OPENAI_API_KEY)",
};

const intOr = (text: string, fallback: number) => {
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) ? n : fallback;
};

function Credential({ name }: { name: CredentialKey }) {
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

  const state = isSet === null ? "unknown" : isSet ? "set" : "not set";
  return (
    <>
      <SettingsRow label={CREDENTIAL_LABELS[name]} hint={`Currently: ${state}. Write-only; the value is never shown.`} error={error}>
        <SettingsInput
          key={`${name}-${isSet}`}
          secureTextEntry
          placeholder={isSet ? "Enter a new value to replace" : "Enter value"}
          onChangeText={setDraft}
          disabled={busy}
        />
      </SettingsRow>
      <SettingsAction label="" actionLabel={busy ? "Saving..." : "Save"} onPress={() => void save()} disabled={busy || draft.length === 0} />
    </>
  );
}

function Template({
  name,
  values,
  update,
  remove,
}: {
  name: string;
  values: KubeAgentsConfig;
  update: (next: KubeAgentsConfig) => void;
  remove?: () => void;
}) {
  const template = values.templates[name] ?? { warmPool: { enabled: false, size: 1, idleTimeoutSeconds: 900 } };
  const set = (patch: Partial<typeof template>) =>
    update({ ...values, templates: { ...values.templates, [name]: { ...template, ...patch } } });
  const pool = template.warmPool;
  return (
    <SettingsSection title={name === "default" ? "Template: default" : `Template: ${name}`}>
      <SettingsCard>
        <SettingsInput
          label="Image"
          hint={name === "default" ? "Falls back to the default image above." : "Empty uses the default image."}
          initialValue={template.image ?? ""}
          onChangeText={(text) => set({ image: text.trim() || undefined })}
        />
        <SettingsSwitch
          label="Warm pool"
          hint="Keep pre-started pods ready. Stored now; takes effect when warm pools ship."
          value={pool.enabled}
          onValueChange={(enabled) => set({ warmPool: { ...pool, enabled } })}
        />
        <SettingsInput
          label="Pool size"
          initialValue={String(pool.size)}
          onChangeText={(t) => set({ warmPool: { ...pool, size: Math.min(20, Math.max(0, intOr(t, pool.size))) } })}
          disabled={!pool.enabled}
        />
        <SettingsInput
          label="Idle timeout (seconds)"
          initialValue={String(pool.idleTimeoutSeconds)}
          onChangeText={(t) => set({ warmPool: { ...pool, idleTimeoutSeconds: Math.max(60, intOr(t, pool.idleTimeoutSeconds)) } })}
          disabled={!pool.enabled}
        />
        {remove ? <SettingsAction label="Remove template" actionLabel="Remove" onPress={remove} /> : null}
      </SettingsCard>
    </SettingsSection>
  );
}

export function KubeAgentsScreen({ theme, layout }: PluginScreenProps) {
  const settings = useSettings(kubeSettings);
  const [draft, setDraft] = useState<KubeAgentsConfig | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
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
  const addTemplate = () => {
    const name = newName.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(name) || draft.templates[name] || name === "default") return;
    setDraft({ ...draft, templates: { ...draft.templates, [name]: { warmPool: { enabled: false, size: 1, idleTimeoutSeconds: 900 } } } });
    setNewName("");
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: pad, gap: 16 }}>
      <Text style={{ color: theme.colors.foregroundMuted }}>
        Each agent that selects the Kube agents provider runs in its own pod. Nothing runs until one does.
      </Text>

      <SettingsSection title="Cluster">
        <SettingsCard>
          <SettingsInput label="Namespace" initialValue={draft.namespace} onChangeText={(namespace) => setDraft({ ...draft, namespace: namespace.trim() })} />
          <SettingsInput label="kubectl context" hint="Empty uses the daemon's current context." initialValue={draft.context ?? ""} onChangeText={(t) => setDraft({ ...draft, context: t.trim() || undefined })} />
          <SettingsInput label="Default image" initialValue={draft.defaultImage} onChangeText={(defaultImage) => setDraft({ ...draft, defaultImage: defaultImage.trim() })} />
        </SettingsCard>
      </SettingsSection>

      {names.map((name) => (
        <Template
          key={name}
          name={name}
          values={draft}
          update={setDraft}
          remove={name === "default" ? undefined : () => {
            const { [name]: _removed, ...rest } = draft.templates;
            setDraft({ ...draft, templates: rest });
          }}
        />
      ))}

      <SettingsSection title="Add template">
        <SettingsCard>
          <SettingsInput label="Name" hint="Select it on an agent with PASEO_KUBE_TEMPLATE=<name>." placeholder="go" onChangeText={setNewName} />
          <SettingsAction label="" actionLabel="Add" onPress={addTemplate} />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Save">
        <SettingsCard>
          <SettingsAction
            label={settings.saveError ? "Not saved" : dirty ? "Unsaved changes" : "Saved"}
            hint={settings.saveError ?? undefined}
            actionLabel={settings.saving ? "Saving..." : "Save settings"}
            disabled={!dirty || settings.saving}
            onPress={() => {
              void settings.save(draft, revision).then((ok) => {
                if (ok) setDraft(null);
              });
            }}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Credentials">
        <SettingsCard>
          {CREDENTIAL_KEYS.map((key) => (
            <Credential key={key} name={key} />
          ))}
        </SettingsCard>
      </SettingsSection>
    </ScrollView>
  );
}
