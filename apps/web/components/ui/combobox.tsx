"use client";

import * as React from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "./button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./command";
import { comboboxCommandFilter, comboboxCustomValue, type ComboboxOption } from "./combobox-utils";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

export { comboboxCommandFilter, comboboxCustomValue, type ComboboxOption } from "./combobox-utils";

interface ComboboxProps {
  readonly id?: string;
  readonly value?: string;
  readonly onValueChange: (value: string) => void;
  readonly options: readonly ComboboxOption[];
  readonly placeholder?: string;
  readonly searchPlaceholder?: string;
  readonly emptyText?: string;
  readonly allowCustomValue?: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly "aria-label"?: string;
  readonly "aria-labelledby"?: string;
  readonly "aria-describedby"?: string;
  readonly "aria-invalid"?: boolean;
}

export function Combobox({
  id,
  value = "",
  onValueChange,
  options,
  placeholder = "请选择",
  searchPlaceholder = "搜索…",
  emptyText = "没有匹配项",
  allowCustomValue = false,
  disabled = false,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
}: Readonly<ComboboxProps>) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const inputReference = React.useRef<HTMLInputElement>(null);
  const triggerReference = React.useRef<HTMLButtonElement>(null);
  const listId = React.useId();
  const selected = options.find((option) => option.value === value);
  const customValue = comboboxCustomValue(search, options, allowCustomValue);

  function changeOpen(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen) requestAnimationFrame(() => inputReference.current?.focus());
    else setSearch("");
  }

  function select(nextValue: string) {
    onValueChange(nextValue);
    setOpen(false);
    setSearch("");
  }

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button
          ref={triggerReference}
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-describedby={ariaDescribedBy}
          aria-invalid={ariaInvalid}
          aria-controls={listId}
          aria-expanded={open}
          disabled={disabled}
          className={cn("w-full min-w-0 justify-between font-normal", className)}
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {selected?.label ?? (value || placeholder)}
          </span>
          <ChevronsUpDown className="text-muted-foreground" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) max-w-[calc(100vw-2rem)] gap-0 p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputReference.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerReference.current?.focus();
        }}
      >
        <Command filter={comboboxCommandFilter} shouldFilter>
          <CommandInput
            ref={inputReference}
            autoFocus
            value={search}
            onValueChange={setSearch}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            disabled={disabled}
          />
          <CommandList id={listId}>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  keywords={[option.label, option.keywords ?? ""]}
                  {...(option.disabled === undefined ? {} : { disabled: option.disabled })}
                  data-checked={option.value === value}
                  onSelect={() => select(option.value)}
                >
                  <Check
                    className={cn("size-4", option.value !== value && "opacity-0")}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 truncate">{option.label}</span>
                </CommandItem>
              ))}
              {customValue === undefined ? null : (
                <CommandItem
                  value={`__custom__:${customValue}`}
                  keywords={[customValue]}
                  onSelect={() => select(customValue)}
                >
                  <span className="size-4 shrink-0" />
                  <span className="min-w-0 truncate">使用“{customValue}”</span>
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
