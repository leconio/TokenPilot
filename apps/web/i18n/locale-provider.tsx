"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

import { translateText, type AppLocale } from "./translator";

const storageKey = "tokenpilot.locale";
const cookieName = "tokenpilot_locale";
const attributes = ["aria-label", "placeholder", "title", "alt"] as const;
const originalText = new WeakMap<Text, string>();
const originalAttributes = new WeakMap<Element, Map<string, string>>();

interface LocaleContextValue {
  readonly locale: AppLocale;
  readonly setLocale: (locale: AppLocale) => void;
  readonly text: (chinese: string, english: string) => string;
}

const LocaleContext = createContext<LocaleContextValue | undefined>(undefined);

function preferredLocale(fallback: AppLocale): AppLocale {
  const saved = window.localStorage.getItem(storageKey);
  if (saved === "en" || saved === "zh-CN") return saved;
  return fallback;
}

function installDocumentTranslator(locale: AppLocale): () => void {
  const observerOptions: MutationObserverInit = {
    attributes: true,
    attributeFilter: [...attributes],
    characterData: true,
    childList: true,
    subtree: true,
  };

  function translateNode(node: Node) {
    if (node instanceof Text) {
      const parent = node.parentElement;
      if (
        parent?.closest("script, style, code, pre, [data-locale-control], [data-i18n-skip]") !==
        null
      )
        return;
      const source = originalText.get(node) ?? node.data;
      originalText.set(node, source);
      node.data = translateText(source, locale);
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.closest("[data-locale-control], [data-i18n-skip]") !== null) return;
    let saved = originalAttributes.get(node);
    if (saved === undefined) {
      saved = new Map();
      originalAttributes.set(node, saved);
    }
    for (const attribute of attributes) {
      const current = node.getAttribute(attribute);
      if (current === null) continue;
      const source = saved.get(attribute) ?? current;
      saved.set(attribute, source);
      node.setAttribute(attribute, translateText(source, locale));
    }
    for (const child of node.childNodes) translateNode(child);
  }

  const observer = new MutationObserver((mutations) => {
    observer.disconnect();
    for (const mutation of mutations) {
      if (mutation.type === "characterData" && mutation.target instanceof Text) {
        originalText.set(mutation.target, mutation.target.data);
        translateNode(mutation.target);
      } else if (mutation.type === "attributes" && mutation.target instanceof Element) {
        const attribute = mutation.attributeName;
        if (attribute !== null) {
          const current = mutation.target.getAttribute(attribute);
          if (current !== null) {
            const saved = originalAttributes.get(mutation.target) ?? new Map<string, string>();
            saved.set(attribute, current);
            originalAttributes.set(mutation.target, saved);
          }
        }
        translateNode(mutation.target);
      } else {
        for (const added of mutation.addedNodes) translateNode(added);
      }
    }
    observer.observe(document.body, observerOptions);
  });
  document.documentElement.lang = locale;
  translateNode(document.body);
  observer.observe(document.body, observerOptions);
  return () => observer.disconnect();
}

export function LocaleProvider({
  children,
  initialLocale,
}: Readonly<{ children: React.ReactNode; initialLocale: AppLocale }>) {
  const [locale, setLocaleState] = useState<AppLocale>(initialLocale);
  useEffect(() => {
    const preferred = preferredLocale(initialLocale);
    if (preferred !== initialLocale) setLocaleState(preferred);
  }, [initialLocale]);
  useEffect(() => installDocumentTranslator(locale), [locale]);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale(next) {
        window.localStorage.setItem(storageKey, next);
        document.cookie = `${cookieName}=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
        setLocaleState(next);
      },
      text: (chinese, english) => (locale === "zh-CN" ? chinese : english),
    }),
    [locale],
  );
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (value === undefined) throw new Error("useLocale must be used inside LocaleProvider");
  return value;
}
