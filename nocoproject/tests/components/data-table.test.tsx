import type { ColumnDef } from '@tanstack/react-table';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

// Outside an `I18nProvider` the runtime returns default values verbatim; interpolate them the way the application does.
vi.mock('@nocobase/i18n/client', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      options?: Record<string, unknown> & { defaultValue?: string },
    ) =>
      (options?.defaultValue ?? key).replace(/{{(\w+)}}/g, (_, name: string) =>
        String(options?.[name]),
      ),
  }),
}));

import { DataTable } from '../../client/components/data-table';
import { DataTableColumnHeader } from '../../client/components/data-table-column-header';

interface Payment {
  id: string;
  email: string;
  amount: number;
}

const columns: ColumnDef<Payment, unknown>[] = [
  {
    accessorKey: 'email',
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='Email' />
    ),
  },
  { accessorKey: 'amount', header: 'Amount' },
];

const payments: Payment[] = Array.from({ length: 12 }, (_, index) => ({
  id: String(index),
  email: `user${index}@example.com`,
  amount: index * 10,
}));

describe('DataTable', () => {
  it('renders headers and one page of rows', () => {
    render(<DataTable columns={columns} data={payments} />);

    expect(screen.getByRole('button', { name: 'Email' })).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Amount' }),
    ).toBeInTheDocument();
    expect(screen.getByText('user0@example.com')).toBeInTheDocument();
    expect(screen.queryByText('user10@example.com')).not.toBeInTheDocument();
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
  });

  it('renders every row when pagination is off', () => {
    render(<DataTable columns={columns} data={payments} pagination={false} />);

    expect(screen.getByText('user11@example.com')).toBeInTheDocument();
    expect(screen.queryByText(/Page 1 of/)).not.toBeInTheDocument();
  });

  it('sorts on a header click: ascending, descending, then back to unsorted', async () => {
    const user = userEvent.setup();
    const data = [
      { id: 'b', email: 'b@example.com', amount: 1 },
      { id: 'a', email: 'a@example.com', amount: 2 },
      { id: 'c', email: 'c@example.com', amount: 3 },
    ];
    render(<DataTable columns={columns} data={data} pagination={false} />);
    const header = screen.getByRole('button', { name: 'Email' });
    const emails = () =>
      screen
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.querySelector('td')?.textContent);

    expect(header).toHaveAttribute('data-sort', 'none');
    expect(emails()).toEqual([
      'b@example.com',
      'a@example.com',
      'c@example.com',
    ]);
    await user.click(header);
    expect(header).toHaveAttribute('data-sort', 'asc');
    expect(emails()).toEqual([
      'a@example.com',
      'b@example.com',
      'c@example.com',
    ]);
    await user.click(header);
    expect(header).toHaveAttribute('data-sort', 'desc');
    expect(emails()).toEqual([
      'c@example.com',
      'b@example.com',
      'a@example.com',
    ]);
    await user.click(header);
    expect(header).toHaveAttribute('data-sort', 'none');
    expect(emails()).toEqual([
      'b@example.com',
      'a@example.com',
      'c@example.com',
    ]);
    // No menu opens from the header.
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('shows the empty message when there is no data', () => {
    render(<DataTable columns={columns} data={[]} />);

    expect(screen.getByText('No results.')).toBeInTheDocument();
  });
});
