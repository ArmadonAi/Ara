import { z } from 'zod';
import { NodeTypeSchema, EdgeTypeSchema } from './types';

export const CreateWorkspaceSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
  projectRoot: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const UpdateWorkspaceSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const AddNodeSchema = z.object({
  type: NodeTypeSchema,
  title: z.string().min(1),
  description: z.string().optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional().default({ x: 0, y: 0 }),
  data: z.record(z.unknown()).optional().default({}),
  sourceRef: z.string().optional(),
});

export const UpdateNodeSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  data: z.record(z.unknown()).optional(),
});

export const AddEdgeSchema = z.object({
  fromNodeId: z.string().min(1),
  toNodeId: z.string().min(1),
  label: z.string().optional(),
  type: EdgeTypeSchema.optional().default('reference'),
  metadata: z.record(z.unknown()).optional(),
});

export const CanvasActionSchema = z.object({
  action: z.string().min(1),
  nodeId: z.string().min(1),
  params: z.record(z.unknown()).optional().default({}),
});
