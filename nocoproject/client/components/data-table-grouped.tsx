import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type Row,
  type SortingState,
  useReactTable,
} from '@tanstack/react-table';
import { Fragment, type ReactElement, type ReactNode, useState } from 'react';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

export interface DataTableGroup {
  readonly id: string;
  /** The group's header row, spanning every column. */
  readonly header: ReactNode;
}

export interface GroupedDataTableProps<TData, TValue = unknown> {
  readonly columns: ColumnDef<TData, TValue>[];
  readonly data: TData[];
  /** In display order; a group without rows is not shown. */
  readonly groups: readonly DataTableGroup[];
  readonly groupOf: (row: TData) => string;
  readonly getRowId?: (row: TData) => string;
  readonly onRowClick?: (row: Row<TData>) => void;
}

/**
 * `DataTable`'s frame and density with the rows split under group header rows (NP-188: runtimes and agents by
 * computer). Sorting a column sorts inside each group; there is no pagination, the groups are the structure.
 */
export function GroupedDataTable<TData, TValue = unknown>({
  columns,
  data,
  groups,
  groupOf,
  getRowId,
  onRowClick,
}: GroupedDataTableProps<TData, TValue>): ReactElement {
  const [sorting, setSorting] = useState<SortingState>([]);
  // See `DataTable`: TanStack Table's mutable instance is not compiler-memoizable.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data,
    columns,
    getRowId,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  const rows = table.getRowModel().rows;
  const width = table.getVisibleLeafColumns().length;

  return (
    <div className='overflow-hidden rounded-lg border bg-card'>
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow
              key={headerGroup.id}
              className='bg-muted/40 hover:bg-muted/40'
            >
              {headerGroup.headers.map((header) => (
                <TableHead
                  key={header.id}
                  colSpan={header.colSpan}
                  className={cn(
                    'px-3 text-muted-foreground',
                    header.column.columnDef.meta?.className,
                  )}
                >
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {groups.map((group) => {
            const members = rows.filter(
              (row) => groupOf(row.original) === group.id,
            );
            if (members.length === 0) return null;
            return (
              <Fragment key={group.id}>
                <TableRow
                  data-group={group.id}
                  className='bg-muted/20 hover:bg-muted/20'
                >
                  <TableCell colSpan={width} className='px-3 py-2'>
                    {group.header}
                  </TableCell>
                </TableRow>
                {members.map((row) => (
                  <TableRow
                    key={row.id}
                    className={onRowClick ? 'cursor-pointer' : undefined}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={cn(
                          'px-3',
                          cell.column.columnDef.meta?.className,
                        )}
                      >
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
