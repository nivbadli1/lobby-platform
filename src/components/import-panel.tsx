"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import {
  commitImport,
  previewImport,
  type CommitState,
  type PreviewState,
} from "@/app/(admin)/buildings/actions";
import { IMPORT_KINDS, type ImportKind } from "@/lib/import/validate";

export function ImportPanel({ buildingId }: { buildingId: string }) {
  const t = useTranslations("import");
  const [kind, setKind] = useState<ImportKind>("units");
  const [state, setState] = useState<PreviewState>({});
  const [result, setResult] = useState<CommitState | null>(null);
  const [pending, startTransition] = useTransition();
  const preview = state.preview;

  function check(formData: FormData) {
    setResult(null);
    startTransition(async () => setState(await previewImport(formData)));
  }

  function commit() {
    if (!preview) return;
    startTransition(async () => {
      const outcome = await commitImport(buildingId, preview.kind, preview.rows);
      setResult(outcome);
      if (outcome.ok) setState({});
    });
  }

  return (
    <section className="card">
      <h2 className="text-lg font-semibold">{t("title")}</h2>
      <p className="mt-1 text-sm text-neutral-600">{t("order")}</p>

      <form action={check} className="mt-4 grid gap-4 sm:grid-cols-[14rem_1fr_auto] sm:items-end">
        <input type="hidden" name="buildingId" value={buildingId} />
        <label className="field">
          <span>{t("kindLabel")}</span>
          <select
            name="kind"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as ImportKind);
              setState({});
              setResult(null);
            }}
          >
            {IMPORT_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`kind.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("file")}</span>
          <input name="file" type="file" accept=".csv,.txt,.tsv,.xlsx" required />
        </label>
        <button type="submit" disabled={pending} className="btn-secondary">
          {pending && !preview ? t("checking") : t("check")}
        </button>
      </form>
      <p className="mt-2 text-sm text-neutral-600">{t(`columnsHint.${kind}`)}</p>

      {state.fileError && <p role="alert" className="mt-4 text-red-700">{t(`fileErrors.${state.fileError}`)}</p>}
      {result?.ok && <p role="status" className="mt-4 text-green-700">{t("done", { count: result.count })}</p>}
      {result && !result.ok && <p role="alert" className="mt-4 text-red-700">{t("commitFailed")}</p>}

      {preview && (
        <div className="mt-4 border-t border-neutral-200 pt-4">
          <p className="font-medium">{t("valid", { count: preview.rows.length })}</p>
          {preview.errors.length > 0 ? (
            <>
              <p role="alert" className="mt-2 text-red-700">{t("errorsTitle", { count: preview.errors.length })}</p>
              <div className="mt-2 max-h-80 overflow-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t("line")}</th>
                      <th>{t("field")}</th>
                      <th>{t("problem")}</th>
                      <th>{t("value")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.errors.map((e, i) => (
                      <tr key={i}>
                        <td>{e.line === 0 ? t("wholeFile") : e.line}</td>
                        <td>{t(`fields.${e.field}`)}</td>
                        <td>{t(`errors.${e.code}`)}</td>
                        <td dir="auto">{e.value ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <button type="button" onClick={commit} disabled={pending || preview.rows.length === 0} className="btn-primary mt-3">
              {pending ? t("committing") : t("commit", { count: preview.rows.length })}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
