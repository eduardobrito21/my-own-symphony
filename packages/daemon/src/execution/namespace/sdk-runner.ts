// Real SDK-backed `InstanceRunner`. Imported by the composition
// root (`packages/daemon/src/index.ts`) when `execution.backend`
// is `namespace`. NOT imported by `backend.ts` or tests — keeps
// the SDK out of the test bundle and out of unit-test reach.

import { Timestamp } from '@bufbuild/protobuf';
import { createClient, type Client } from '@connectrpc/connect';
import { createRegionTransport } from '@namespacelabs/sdk/api';
import { createComputeClient } from '@namespacelabs/sdk/api/compute';
import { loadDefaults } from '@namespacelabs/sdk/auth';

// Deep proto imports — see proto-shim.ts for the ambient module
// declarations that make these paths resolve under TypeScript.
import './proto-shim.js';
import {
  ContainerRequest,
  EnvironmentVariable,
} from '@namespacelabs/sdk/proto/namespace/cloud/compute/v1beta/compute_pb';
import {
  Command,
  RunCommandRequest,
} from '@namespacelabs/sdk/proto/namespace/cloud/compute/v1beta/command_pb';
import { CommandService } from '@namespacelabs/sdk/proto/namespace/cloud/compute/v1beta/command_connect';

import type { InstanceRunner, NamespaceRunnerOptions, RunCommandChunk } from './instance-runner.js';

// Connect's `createClient<S>` infers methods from the service
// descriptor's metadata. The CommandService descriptor is opaque
// from our side (typed `unknown`), so we treat the resulting
// client as a record of plausibly-named methods. The runtime
// returns the real generated client; we just type it loosely.
interface CommandServiceClient {
  runCommandSync(req: InstanceType<typeof RunCommandRequest>): Promise<{
    exitStatus?: { exitCode: number };
    stdout?: Uint8Array;
    stderr?: Uint8Array;
  }>;
  runCommand(
    req: InstanceType<typeof RunCommandRequest>,
    opts?: { signal: AbortSignal },
  ): AsyncIterable<{
    stream: number;
    data: Uint8Array;
    exitStatus?: { exitCode: number };
  }>;
}

/**
 * Build a real `InstanceRunner` against `@namespacelabs/sdk`.
 *
 * Auth: uses `loadDefaults()`, which checks `NSC_TOKEN_FILE`,
 * the workload-token path, and finally the user's local config
 * (the result of `nsc auth login`).
 *
 * Region: defaults to `'us'`. Override via
 * `execution.namespace.region` in `symphony.yaml`.
 */
export async function createNamespaceInstanceRunner(
  opts: NamespaceRunnerOptions = {},
): Promise<InstanceRunner> {
  const region = opts.region ?? 'us';

  const tokenSource = await loadDefaults();
  const computeClient = createComputeClient({ tokenSource, region });
  const transport = createRegionTransport(region, { tokenSource });
  // `CommandService` is typed `unknown` (see proto-shim) — Connect
  // accepts it at runtime; we cast the resulting client to the
  // shape we need.
  const commandClient = createClient(
    CommandService as Parameters<typeof createClient>[0],
    transport,
  ) as unknown as CommandServiceClient & Client<never>;

  function envVarsToProto(
    env: Readonly<Record<string, string>> | undefined,
  ): EnvironmentVariable[] {
    if (env === undefined) return [];
    return Object.entries(env).map(([name, value]) => new EnvironmentVariable({ name, value }));
  }

  const runner: InstanceRunner = {
    async createInstance(args) {
      const containers = [
        new ContainerRequest({
          name: args.containerName,
          imageRef: args.baseImage,
          envVars: envVarsToProto(args.env),
        }),
      ];
      const response = await computeClient.compute.createInstance({
        shape: {
          virtualCpu: args.shape.vcpu,
          memoryMegabytes: args.shape.memoryMb,
          machineArch: args.shape.arch,
        },
        documentedPurpose: args.documentedPurpose,
        deadline: Timestamp.fromDate(args.deadline),
        containers,
      });
      const id = response.metadata?.instanceId;
      if (id === undefined || id.length === 0) {
        throw new Error('createInstance returned no instanceId');
      }
      return { instanceId: id };
    },

    async waitInstance(instanceId, signal) {
      const stream = computeClient.compute.waitInstance(
        { instanceId },
        signal !== undefined ? { signal } : undefined,
      );
      for await (const response of stream) {
        if (response.metadata !== undefined) return;
      }
    },

    async runCommandSync(args) {
      const cmd = new Command({
        command: [...args.command],
        envVars: envVarsToProto(args.env),
        ...(args.cwd !== undefined && { cwd: args.cwd }),
      });
      const req = new RunCommandRequest({
        instanceId: args.instanceId,
        targetContainerName: args.containerName,
        command: cmd,
      });
      const response = await commandClient.runCommandSync(req);
      return {
        exitCode: response.exitStatus?.exitCode ?? -1,
        stdout: bytesToString(response.stdout),
        stderr: bytesToString(response.stderr),
      };
    },

    async *runCommandStream(args, signal): AsyncIterable<RunCommandChunk> {
      const cmd = new Command({
        command: [...args.command],
        envVars: envVarsToProto(args.env),
        ...(args.cwd !== undefined && { cwd: args.cwd }),
      });
      const req = new RunCommandRequest({
        instanceId: args.instanceId,
        targetContainerName: args.containerName,
        command: cmd,
      });
      const stream = commandClient.runCommand(req, signal !== undefined ? { signal } : undefined);
      for await (const chunk of stream) {
        if (chunk.exitStatus !== undefined) {
          yield { kind: 'exit', exitCode: chunk.exitStatus.exitCode };
          return;
        }
        if (chunk.data.length > 0) {
          // Stream enum: STDOUT=1, STDERR=2.
          const which = chunk.stream === 2 ? 'stderr' : 'stdout';
          yield { kind: 'data', stream: which, data: bytesToString(chunk.data) };
        }
      }
    },

    async destroyInstance(instanceId, reason) {
      try {
        await computeClient.compute.destroyInstance({ instanceId, reason });
      } catch (cause) {
        // Treat 404 / not-found as ok. Connect-RPC surfaces these
        // as ConnectError with code "not_found".
        const msg = cause instanceof Error ? cause.message.toLowerCase() : '';
        if (msg.includes('not_found') || msg.includes('not found')) return;
        throw cause;
      }
    },
  };

  return runner;
}

function bytesToString(b: Uint8Array | undefined): string {
  if (b === undefined || b.length === 0) return '';
  return Buffer.from(b).toString('utf8');
}
