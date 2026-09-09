import { UploadCloud, LockKeyhole, ArrowRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const previews = [
  {
    title: 'Publish to YouTube',
    icon: UploadCloud,
    text: 'A future publishing workspace for secure channel connection, scheduling, and upload reconciliation.',
    action: 'Phase 6 publishing',
    stages: ['Connect channel', 'Schedule privately', 'Verify publication'],
  },
] as const;

export function FuturePreview() {
  return (
    <section className="future-section" aria-labelledby="future-title">
      <div className="section-heading">
        <div>
          <h2 id="future-title">Coming next to your studio</h2>
          <p>A look ahead. These tools are not available yet.</p>
        </div>
        <Badge variant="outline">Visual preview only</Badge>
      </div>
      <Tabs defaultValue="0" orientation="vertical" className="future-layout">
        <TabsList className="preview-picker" aria-label="Future feature previews">
          {previews.map((item, index) => (
            <TabsTrigger key={item.title} value={String(index)}>
              <item.icon size={20} aria-hidden="true" />
              <span>
                <strong>{item.title}</strong>
                <small>{item.action}</small>
              </span>
              <ArrowRight size={16} aria-hidden="true" />
            </TabsTrigger>
          ))}
        </TabsList>
        {previews.map((preview, index) => (
          <TabsContent key={preview.title} value={String(index)} className="preview-detail">
            <div className="preview-stages" aria-label="Planned workflow">
              {preview.stages.map((stage, index) => (
                <div key={stage}>
                  <span>{index + 1}</span>
                  <strong>{stage}</strong>
                </div>
              ))}
            </div>
            <p>{preview.text}</p>
            <div className="preview-disclaimer">
              <Button variant="secondary" disabled>
                <LockKeyhole data-icon="inline-start" />
                Planned feature
              </Button>
              <span>No scheduling or publishing occurs in this preview.</span>
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </section>
  );
}
