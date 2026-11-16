"use client"

import * as React from "react"

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"

export type ConfirmOptions = {
  title: string
  description?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** Styles the confirm button as destructive (removals, deletions). */
  destructive?: boolean
}

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void }

/**
 * An in-app replacement for `window.confirm`: `await confirm({...})` resolves `true` when the person confirms and `false` when they
 * cancel, press Escape or close the dialog. Render `confirmDialog` once in the component that calls `confirm`.
 *
 * Test ids: `confirm-dialog`, `confirm-dialog-confirm`, `confirm-dialog-cancel`.
 */
export function useConfirm(): {
  confirm: (options: ConfirmOptions) => Promise<boolean>
  confirmDialog: React.ReactElement
} {
  const [pending, setPending] = React.useState<Pending | null>(null)
  // Keep the last options while the dialog animates closed so its text does not blank out mid-exit.
  const [shown, setShown] = React.useState<ConfirmOptions | null>(null)

  const confirm = React.useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setShown(options)
        setPending((previous) => {
          previous?.resolve(false)
          return { ...options, resolve }
        })
      }),
    []
  )

  const settle = React.useCallback((ok: boolean) => {
    setPending((current) => {
      current?.resolve(ok)
      return null
    })
  }, [])

  const confirmDialog = (
    <AlertDialog open={pending !== null} onOpenChange={(open) => { if (!open) settle(false) }}>
      <AlertDialogContent data-testid="confirm-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{shown?.title}</AlertDialogTitle>
          {shown?.description ? <AlertDialogDescription>{shown.description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" data-testid="confirm-dialog-cancel" />}>
            {shown?.cancelLabel ?? "Cancel"}
          </AlertDialogClose>
          <Button
            variant={shown?.destructive ? "destructive" : "default"}
            data-testid="confirm-dialog-confirm"
            onClick={() => settle(true)}
          >
            {shown?.confirmLabel ?? "Confirm"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  return { confirm, confirmDialog }
}
