import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Gate to development only
export const dynamic = "force-dynamic";

const colors = [
  { name: "background", hex: "#14141C", token: "bg-background" },
  { name: "foreground", hex: "#e3e1e4", token: "text-foreground" },
  { name: "card", hex: "#1c1c26", token: "bg-card" },
  { name: "popover", hex: "#22222e", token: "bg-popover" },
  { name: "primary", hex: "#A97FB7", token: "bg-primary" },
  { name: "secondary", hex: "#F5C0C0", token: "bg-secondary" },
  { name: "muted", hex: "#2a2a36", token: "bg-muted" },
  { name: "muted-foreground", hex: "#8a8694", token: "text-muted-foreground" },
  { name: "accent", hex: "#3a3a48", token: "bg-accent" },
  { name: "border", hex: "#333340", token: "border-border" },
  { name: "destructive", hex: "#e55b5b", token: "bg-destructive" },
  { name: "success", hex: "#5bc27a", token: "bg-success" },
  { name: "warning", hex: "#e5a93b", token: "bg-warning" },
  { name: "info", hex: "#6ba3e8", token: "bg-info" },
];

export default function DesignSystemPage() {
  if (process.env.NODE_ENV !== "development") {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground">
          This page is only available in development mode.
        </p>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="surface-base min-h-screen p-space-8">
        <div className="max-w-6xl mx-auto space-y-space-10">
          {/* Header */}
          <header>
            <h1 className="text-display text-foreground">
              Super Schema Design System
            </h1>
            <p className="text-body text-muted-foreground mt-space-2">
              Hex-inspired dark theme foundation
            </p>
          </header>

          {/* Color Swatches */}
          <section>
            <h2 className="text-heading-1 text-foreground mb-space-4">
              Color Palette
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-space-3">
              {colors.map((c) => (
                <div key={c.name} className="space-y-space-1">
                  <div
                    className="w-full h-16 rounded-lg border border-border"
                    style={{ backgroundColor: c.hex }}
                  />
                  <p className="text-caption text-foreground">{c.name}</p>
                  <p className="text-mono-small text-muted-foreground">
                    {c.hex}
                  </p>
                </div>
              ))}
            </div>
          </section>

          {/* Surfaces */}
          <section>
            <h2 className="text-heading-1 text-foreground mb-space-4">
              Surface Layers
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-5 gap-space-4">
              <div className="surface-base p-space-6 rounded-lg border border-border">
                <p className="text-heading-3">Base</p>
                <p className="text-mono-small text-muted-foreground">
                  #14141C
                </p>
              </div>
              <div className="surface-1 p-space-6 rounded-lg">
                <p className="text-heading-3">Surface 1</p>
                <p className="text-mono-small text-muted-foreground">
                  #1c1c26 + shadow
                </p>
              </div>
              <div className="surface-2 p-space-6 rounded-lg">
                <p className="text-heading-3">Surface 2</p>
                <p className="text-mono-small text-muted-foreground">
                  #22222e + deeper shadow
                </p>
              </div>
              <div className="surface-glass p-space-6 rounded-lg">
                <p className="text-heading-3">Glass</p>
                <p className="text-mono-small text-muted-foreground">
                  Frosted glass
                </p>
              </div>
              <div className="surface-overlay p-space-6 rounded-lg">
                <p className="text-heading-3 text-white">Overlay</p>
                <p className="text-mono-small text-white/60">Modal backdrop</p>
              </div>
            </div>
          </section>

          {/* Typography */}
          <section>
            <h2 className="text-heading-1 text-foreground mb-space-4">
              Typography Scale
            </h2>
            <div className="surface-1 p-space-6 rounded-lg space-y-space-4">
              <div>
                <p className="text-caption text-muted-foreground mb-1">
                  display / 28px / 600
                </p>
                <p className="text-display">Display Heading</p>
              </div>
              <div>
                <p className="text-caption text-muted-foreground mb-1">
                  heading-1 / 22px / 600
                </p>
                <p className="text-heading-1">Heading One</p>
              </div>
              <div>
                <p className="text-caption text-muted-foreground mb-1">
                  heading-2 / 18px / 500
                </p>
                <p className="text-heading-2">Heading Two</p>
              </div>
              <div>
                <p className="text-caption text-muted-foreground mb-1">
                  heading-3 / 15px / 500
                </p>
                <p className="text-heading-3">Heading Three</p>
              </div>
              <div>
                <p className="text-caption text-muted-foreground mb-1">
                  body / 14px / 400
                </p>
                <p className="text-body">Body text for regular content.</p>
              </div>
              <div>
                <p className="text-caption text-muted-foreground mb-1">
                  body-small / 13px / 400
                </p>
                <p className="text-body-small">Small body text for secondary content.</p>
              </div>
              <div>
                <p className="text-caption text-muted-foreground mb-1">
                  caption / 11px / 500
                </p>
                <p className="text-caption">CAPTION TEXT FOR LABELS</p>
              </div>
              <div>
                <p className="text-caption text-muted-foreground mb-1">
                  mono / 13px / 400
                </p>
                <p className="text-mono">const schemaField = &quot;user_id&quot;;</p>
              </div>
              <div>
                <p className="text-caption text-muted-foreground mb-1">
                  mono-small / 12px / 400
                </p>
                <p className="text-mono-small">type: string | null</p>
              </div>
            </div>
          </section>

          {/* Spacing */}
          <section>
            <h2 className="text-heading-1 text-foreground mb-space-4">
              Spacing Tokens (4px base)
            </h2>
            <div className="surface-1 p-space-6 rounded-lg space-y-space-2">
              {[
                { name: "space-1", px: "4px" },
                { name: "space-2", px: "8px" },
                { name: "space-3", px: "12px" },
                { name: "space-4", px: "16px" },
                { name: "space-6", px: "24px" },
                { name: "space-8", px: "32px" },
                { name: "space-10", px: "40px" },
              ].map((s) => (
                <div key={s.name} className="flex items-center gap-space-4">
                  <span className="text-mono-small text-muted-foreground w-24">
                    {s.name}
                  </span>
                  <div
                    className="h-3 bg-primary rounded"
                    style={{ width: s.px }}
                  />
                  <span className="text-caption text-muted-foreground">
                    {s.px}
                  </span>
                </div>
              ))}
            </div>
          </section>

          {/* Classification Badges */}
          <section>
            <h2 className="text-heading-1 text-foreground mb-space-4">
              Classification Badges
            </h2>
            <div className="flex flex-wrap gap-space-3">
              <Badge variant="pii">PII</Badge>
              <Badge variant="sensitive">SENSITIVE</Badge>
              <Badge variant="internal">INTERNAL</Badge>
              <Badge variant="public">PUBLIC</Badge>
              <Badge variant="destructive">DESTRUCTIVE</Badge>
              <Badge variant="success">SUCCESS</Badge>
              <Badge variant="warning">WARNING</Badge>
              <Badge variant="info">INFO</Badge>
              <Badge variant="default">DEFAULT</Badge>
              <Badge variant="secondary">SECONDARY</Badge>
              <Badge variant="outline">OUTLINE</Badge>
            </div>
          </section>

          {/* Buttons */}
          <section>
            <h2 className="text-heading-1 text-foreground mb-space-4">
              Buttons
            </h2>
            <div className="flex flex-wrap gap-space-3">
              <Button>Primary</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="destructive">Destructive</Button>
              <Button variant="link">Link</Button>
              <Button disabled>Disabled</Button>
            </div>
          </section>

          {/* Input */}
          <section>
            <h2 className="text-heading-1 text-foreground mb-space-4">
              Input
            </h2>
            <div className="max-w-sm space-y-space-3">
              <Input placeholder="Default input..." />
              <Input placeholder="Disabled input..." disabled />
            </div>
          </section>

          {/* Tabs */}
          <section>
            <h2 className="text-heading-1 text-foreground mb-space-4">Tabs</h2>
            <Tabs defaultValue="fields" className="max-w-md">
              <TabsList>
                <TabsTrigger value="fields">Fields</TabsTrigger>
                <TabsTrigger value="decorators">Decorators</TabsTrigger>
                <TabsTrigger value="preview">Preview</TabsTrigger>
              </TabsList>
              <TabsContent value="fields" className="surface-1 p-space-4 rounded-lg mt-space-2">
                <p className="text-body">Field editor content goes here.</p>
              </TabsContent>
              <TabsContent value="decorators" className="surface-1 p-space-4 rounded-lg mt-space-2">
                <p className="text-body">Decorator panel content.</p>
              </TabsContent>
              <TabsContent value="preview" className="surface-1 p-space-4 rounded-lg mt-space-2">
                <p className="text-body">Schema preview content.</p>
              </TabsContent>
            </Tabs>
          </section>

          {/* Select */}
          <section>
            <h2 className="text-heading-1 text-foreground mb-space-4">
              Select
            </h2>
            <Select>
              <SelectTrigger className="w-48">
                <SelectValue placeholder="Select type..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="string">String</SelectItem>
                <SelectItem value="number">Number</SelectItem>
                <SelectItem value="boolean">Boolean</SelectItem>
                <SelectItem value="date">Date</SelectItem>
              </SelectContent>
            </Select>
          </section>

          {/* Accordion */}
          <section>
            <h2 className="text-heading-1 text-foreground mb-space-4">
              Accordion
            </h2>
            <Accordion className="max-w-md">
              <AccordionItem value="item-1">
                <AccordionTrigger>Entity Properties</AccordionTrigger>
                <AccordionContent>
                  Configure entity-level metadata and properties.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="item-2">
                <AccordionTrigger>Field Decorators</AccordionTrigger>
                <AccordionContent>
                  Add decorators like @doc, @format, @minLength.
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </section>

          {/* Table */}
          <section>
            <h2 className="text-heading-1 text-foreground mb-space-4">
              Data Table
            </h2>
            <div className="rounded-lg border border-border overflow-hidden max-w-2xl">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50 hover:bg-muted/50">
                    <TableHead>Field</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Classification</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow className="animate-field-hover">
                    <TableCell className="text-mono">user_id</TableCell>
                    <TableCell>string</TableCell>
                    <TableCell>
                      <Badge variant="pii">PII</Badge>
                    </TableCell>
                  </TableRow>
                  <TableRow className="animate-field-hover">
                    <TableCell className="text-mono">email</TableCell>
                    <TableCell>string</TableCell>
                    <TableCell>
                      <Badge variant="sensitive">SENSITIVE</Badge>
                    </TableCell>
                  </TableRow>
                  <TableRow className="animate-field-hover">
                    <TableCell className="text-mono">created_at</TableCell>
                    <TableCell>timestamp</TableCell>
                    <TableCell>
                      <Badge variant="internal">INTERNAL</Badge>
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </section>

          {/* Tooltip */}
          <section>
            <h2 className="text-heading-1 text-foreground mb-space-4">
              Tooltip
            </h2>
            <Tooltip>
              <TooltipTrigger
                render={<Button variant="outline">Hover me</Button>}
              />
              <TooltipContent>
                <p>Field completeness: 85%</p>
              </TooltipContent>
            </Tooltip>
          </section>

          {/* Animations Demo */}
          <section>
            <h2 className="text-heading-1 text-foreground mb-space-4">
              Micro-Animations
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-space-3">
              <div className="surface-1 p-space-4 rounded-lg animate-field-hover hover:bg-accent cursor-pointer">
                <p className="text-body-small">Field Hover (150ms)</p>
              </div>
              <div className="surface-1 p-space-4 rounded-lg animate-panel-expand hover:scale-[1.02] cursor-pointer">
                <p className="text-body-small">Panel Expand (200ms)</p>
              </div>
              <div className="surface-1 p-space-4 rounded-lg animate-tab-switch hover:bg-primary/20 cursor-pointer">
                <p className="text-body-small">Tab Switch (150ms)</p>
              </div>
              <div className="surface-1 p-space-4 rounded-lg animate-tile-toggle hover:translate-y-[-2px] cursor-pointer">
                <p className="text-body-small">Tile Toggle (300ms)</p>
              </div>
            </div>
          </section>

          {/* Footer */}
          <footer className="border-t border-border pt-space-6 pb-space-10">
            <p className="text-caption text-muted-foreground">
              Super Schema Design System v1.0 — Development Only
            </p>
          </footer>
        </div>
      </div>
    </TooltipProvider>
  );
}
