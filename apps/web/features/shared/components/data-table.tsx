"use client";

import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { ChevronLeft, ChevronRight, Columns3, Download, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useLocale } from "@/i18n/locale-provider";
import { translateText, type AppLocale } from "@/i18n/translator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageState } from "./page-state";

export interface DataColumn<T extends object> {
  key: string;
  label: string;
  cell?: (row: T) => React.ReactNode;
  exportValue?: (row: T) => unknown;
}

export interface ServerPage {
  page: number;
  pageSize: number;
  total: number;
  hasNext?: boolean;
  onPageChange?: (page: number) => void;
}

function csvCell(value: unknown): string {
  let text =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  if (/^[\t\r\n ]*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function exportRows<T extends object>(
  rows: readonly T[],
  columns: readonly DataColumn<T>[],
  fileName: string,
  locale: AppLocale,
) {
  const content = [
    columns.map((column) => csvCell(translateText(column.label, locale))).join(","),
    ...rows.map((row) =>
      columns
        .map((column) =>
          csvCell(column.exportValue?.(row) ?? (row as Record<string, unknown>)[column.key] ?? ""),
        )
        .join(","),
    ),
  ].join("\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(
    new Blob(["\uFEFF", content], { type: "text/csv;charset=utf-8" }),
  );
  link.download = `${translateText(fileName, locale)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

export function DataTable<T extends object>({
  rows,
  columns,
  onRowClick,
  emptyMessage,
  pagination,
  exportFileName = "数据",
  showColumnSelector = true,
  showExport = true,
}: Readonly<{
  rows: T[];
  columns: DataColumn<T>[];
  onRowClick?: ((row: T) => void) | undefined;
  emptyMessage?: string | undefined;
  pagination?: ServerPage | undefined;
  exportFileName?: string | undefined;
  showColumnSelector?: boolean | undefined;
  showExport?: boolean | undefined;
}>) {
  const { locale, text } = useLocale();
  const [filter, setFilter] = useState("");
  const [sorting, setSorting] = useState<SortingState>([]);
  const [visibility, setVisibility] = useState<VisibilityState>({});
  const filtered = useMemo(
    () => rows.filter((row) => JSON.stringify(row).toLowerCase().includes(filter.toLowerCase())),
    [filter, rows],
  );
  const definitions = useMemo<ColumnDef<T>[]>(
    () =>
      columns.map((column) => ({
        id: column.key,
        accessorKey: column.key,
        header: column.label,
        cell: ({ row }) =>
          column.cell?.(row.original) ??
          String((row.original as Record<string, unknown>)[column.key] ?? "-"),
      })),
    [columns],
  );
  const table = useReactTable({
    data: filtered,
    columns: definitions,
    state: { sorting, columnVisibility: visibility },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    manualPagination: pagination !== undefined,
  });
  return (
    <div className="panel responsive-data-table">
      <div className="toolbar">
        <div className="search">
          <Search aria-hidden="true" size={15} />
          <Input
            aria-label="过滤表格"
            placeholder="过滤当前页…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
        <Badge variant="outline">
          {pagination
            ? `${rows.length} / ${pagination.total}`
            : `${filtered.length} ${text("条", "rows")}`}
        </Badge>
        {showColumnSelector ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button aria-label="选择显示列" size="sm" variant="outline">
                <Columns3 />列
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>显示列</DropdownMenuLabel>
              {table.getAllLeafColumns().map((column) => (
                <DropdownMenuCheckboxItem
                  checked={column.getIsVisible()}
                  key={column.id}
                  onCheckedChange={(value) => column.toggleVisibility(Boolean(value))}
                >
                  {String(column.columnDef.header)}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {showExport ? (
          <Button
            aria-label="导出当前表格"
            size="sm"
            variant="outline"
            onClick={() =>
              exportRows(
                table.getRowModel().rows.map((row) => row.original),
                columns.filter((column) => table.getColumn(column.key)?.getIsVisible() !== false),
                exportFileName,
                locale,
              )
            }
          >
            <Download />
            导出
          </Button>
        ) : null}
      </div>
      {filtered.length === 0 ? (
        <PageState state="empty" message={emptyMessage} />
      ) : (
        <div className="table-wrap">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id}>
                  {group.headers.map((header) => (
                    <TableHead key={header.id}>
                      <Button
                        className="h-auto p-0 font-medium"
                        size="sm"
                        type="button"
                        variant="ghost"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </Button>
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow
                  className={
                    onRowClick
                      ? "cursor-pointer outline-none focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/30"
                      : undefined
                  }
                  key={row.id}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onRowClick(row.original);
                          }
                        }
                      : undefined
                  }
                  tabIndex={onRowClick ? 0 : undefined}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      data-label={String(cell.column.columnDef.header ?? cell.column.id)}
                      key={cell.id}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {pagination ? (
        <div className="flex items-center justify-end gap-2 border-t p-3">
          <span className="text-sm text-muted-foreground">第 {pagination.page} 页</span>
          <Button
            aria-label="上一页"
            disabled={pagination.page <= 1}
            size="icon-sm"
            variant="outline"
            onClick={() => pagination.onPageChange?.(pagination.page - 1)}
          >
            <ChevronLeft />
          </Button>
          <Button
            aria-label="下一页"
            disabled={
              pagination.hasNext === undefined
                ? pagination.page * pagination.pageSize >= pagination.total
                : !pagination.hasNext
            }
            size="icon-sm"
            variant="outline"
            onClick={() => pagination.onPageChange?.(pagination.page + 1)}
          >
            <ChevronRight />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
