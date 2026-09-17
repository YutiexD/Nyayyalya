/**
 * The investigating officer's workspace: your cases on the left, the selected case on
 * the right — its stage, its court, "Upload evidence", "File chargesheet", and the
 * evidence with each exhibit's certificate and FSL verdict.
 */
import { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { toast } from 'sonner';
import { FileText, FolderPlus, Gavel, Loader2, Scale, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';

import {
  DetailSkeleton, Empty, Panel, Rows, RowsSkeleton, SectionHeader, SplitView, Workspace,
} from '@/components/common/Shell';
import { CaseLifecycle } from '@/components/common/Lifecycle';
import { CaseClosure, CaseTimeline } from '@/components/common/CaseRecord';
import { Denial } from '@/components/common/Verdicts';
import { UploadEvidenceDialog } from '@/features/officer/UploadPipeline';
import {
  CaseHeading, CaseListItem, CourtFact, EvidenceTable, WRITABLE_STAGES,
} from '@/features/officer/CaseParts';
import { ExhibitDialog, useExhibitDialog } from '@/features/evidence/ExhibitDialog';
import { useCaseOverview, useCases, useCreateCaseFromFir, useFileChargesheet } from '@/hooks/queries';
import { workingCaseSet, selectWorkingCaseId } from '@/features/ui/uiSlice';

// ============================================================ open a case ====

function OpenCaseDialog() {
  const [open, setOpen] = useState(false);
  const [fir, setFir] = useState('');
  const create = useCreateCaseFromFir();
  const dispatch = useDispatch();

  const onSubmit = (e) => {
    e.preventDefault();
    create.mutate(fir.trim(), {
      onSuccess: (d) => {
        toast.success(`Case opened · FIR ${d.case.firNumber}`);
        dispatch(workingCaseSet(String(d.case._id)));
        setFir('');
        setOpen(false);
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) create.reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <FolderPlus />
          Open case
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Open case</DialogTitle>
          <DialogDescription className="sr-only">Enter the FIR number.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="fir">FIR number</Label>
            <Input
              id="fir"
              value={fir}
              onChange={(e) => setFir(e.target.value)}
              placeholder="0124/2026"
              autoFocus
              required
            />
          </div>
          {create.isError && <Denial error={create.error} heading="Case not opened" />}
          <DialogFooter>
            <Button type="submit" className="w-full" disabled={create.isPending || !fir.trim()}>
              {create.isPending ? <Loader2 className="animate-spin" /> : <FileText />}
              Open case
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ======================================================= file chargesheet ====

function FileChargesheetDialog({ caseDoc }) {
  const file = useFileChargesheet();
  const [open, setOpen] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (file.isPending) return;
        setOpen(next);
        if (!next) file.reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <Gavel />
          File chargesheet
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>File chargesheet?</DialogTitle>
          <DialogDescription>
            FIR {caseDoc.firNumber} goes to the court. No more evidence can be uploaded after this.
          </DialogDescription>
        </DialogHeader>
        {file.isError && <Denial error={file.error} heading="Chargesheet not filed" />}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={file.isPending}>
            Cancel
          </Button>
          <Button
            disabled={file.isPending}
            onClick={() =>
              file.mutate(caseDoc._id, {
                onSuccess: (d) => {
                  toast.success('Chargesheet filed', {
                    description: [d.case?.courtName, d.case?.cnrNumber && `CNR ${d.case.cnrNumber}`]
                      .filter(Boolean)
                      .join(' · '),
                  });
                  setOpen(false);
                },
              })
            }
          >
            {file.isPending && <Loader2 className="animate-spin" />}
            File chargesheet
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ================================================================ the case ====

function CaseDetail({ caseId }) {
  const overview = useCaseOverview(caseId);
  const exhibitDialog = useExhibitDialog();

  if (!caseId) {
    return (
      <Panel>
        <Empty title="Select a case" icon={Scale} />
      </Panel>
    );
  }
  if (overview.isPending) {
    return (
      <Panel>
        <DetailSkeleton />
      </Panel>
    );
  }
  if (overview.isError) {
    return (
      <Panel>
        <Denial error={overview.error} heading="Case not readable" />
      </Panel>
    );
  }

  const c = overview.data?.case;
  if (!c) {
    return (
      <Panel>
        <Empty title="Case not found" icon={Scale} />
      </Panel>
    );
  }

  const workflow = overview.data?.workflow;
  const evidence = overview.data?.evidence ?? [];
  const writable = WRITABLE_STAGES.includes(c.stage);
  const canFile =
    writable &&
    (workflow ? workflow.nextPoliceAction?.action === 'FILE_CHARGESHEET' : true);

  return (
    <section className="surface overflow-hidden">
      <div className="space-y-5 p-6">
        <CaseHeading
          c={c}
          actions={
            <>
              {canFile && <FileChargesheetDialog caseDoc={c} />}
              {writable && (
                <UploadEvidenceDialog
                  caseId={caseId}
                  caseInfo={{ firNumber: c.firNumber }}
                  trigger={
                    <Button>
                      <Upload />
                      Upload evidence
                    </Button>
                  }
                />
              )}
            </>
          }
        />
        <CaseLifecycle stage={c.stage} workflow={workflow} compact />
        <CourtFact c={c} />
        <CaseClosure caseId={caseId} caseDoc={c} />
      </div>

      <CaseTimeline entries={workflow?.lifecycle} variant="section" />

      <div className="border-t">
        <SectionHeader
          title={`Evidence${evidence.length ? ` (${evidence.length})` : ''}`}
          className="px-6 pb-2 pt-5"
        />
        <div className="pb-2">
          <EvidenceTable
            evidence={evidence}
            onOpen={exhibitDialog.open}
            caseInfo={{ firNumber: c.firNumber }}
            empty={
              <Empty
                title="No evidence uploaded"
                icon={Upload}
                action={writable ? <UploadEvidenceDialog caseId={caseId} caseInfo={{ firNumber: c.firNumber }} /> : null}
              />
            }
          />
        </div>
      </div>

      <ExhibitDialog
        evidenceId={exhibitDialog.evidenceId}
        onClose={exhibitDialog.close}
        caseInfo={{ firNumber: c.firNumber }}
      />
    </section>
  );
}

// ==================================================================== page ====

export default function OfficerPage() {
  const dispatch = useDispatch();
  const workingCaseId = useSelector(selectWorkingCaseId);
  const casesQuery = useCases({ limit: 100 });
  const cases = useMemo(() => casesQuery.data?.cases ?? [], [casesQuery.data]);

  // Land on a case, but never override a choice still in the list.
  useEffect(() => {
    if (!cases.length) return;
    if (!workingCaseId || !cases.some((c) => String(c._id) === String(workingCaseId))) {
      dispatch(workingCaseSet(String(cases[0]._id)));
    }
  }, [cases, workingCaseId, dispatch]);

  return (
    <Workspace title="Your cases" action={<OpenCaseDialog />}>
      {casesQuery.isError && <Denial error={casesQuery.error} heading="Cases not readable" />}

      <SplitView
        sticky
        list={
          <Panel bodyClassName="p-0">
            {casesQuery.isPending && <RowsSkeleton />}
            {casesQuery.isSuccess && cases.length === 0 && (
              <Empty title="No cases yet" icon={FileText} action={<OpenCaseDialog />} />
            )}
            {cases.length > 0 && (
              <Rows>
                {cases.map((c) => (
                  <CaseListItem
                    key={c._id}
                    c={c}
                    selected={String(c._id) === String(workingCaseId)}
                    onSelect={() => dispatch(workingCaseSet(String(c._id)))}
                  />
                ))}
              </Rows>
            )}
          </Panel>
        }
        detail={<CaseDetail caseId={workingCaseId} />}
      />
    </Workspace>
  );
}
