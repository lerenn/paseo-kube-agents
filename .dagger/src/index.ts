/**
 * CI for a Paseo plugin: typecheck, test and build in a Node container.
 * Every function takes the repository root as `source`.
 */
import { dag, Container, Directory, object, func, argument } from "@dagger.io/dagger"

@object()
export class Ci {
  /** Node container with the repository mounted and dependencies installed. */
  @func()
  base(@argument({ defaultPath: "/", ignore: ["node_modules", ".git", ".dagger/sdk"] }) source: Directory): Container {
    return dag
      .container()
      .from("node:22-slim")
      .withMountedCache("/root/.npm", dag.cacheVolume("npm"))
      .withDirectory("/src", source)
      .withWorkdir("/src")
      .withExec(["npm", "ci", "--no-audit", "--no-fund"])
  }

  /** Run `npm run typecheck`. */
  @func()
  async typecheck(@argument({ defaultPath: "/", ignore: ["node_modules", ".git", ".dagger/sdk"] }) source: Directory): Promise<string> {
    return this.base(source).withExec(["npm", "run", "typecheck"]).stdout()
  }

  /** Run `npm test`. */
  @func()
  async test(@argument({ defaultPath: "/", ignore: ["node_modules", ".git", ".dagger/sdk"] }) source: Directory): Promise<string> {
    return this.base(source).withExec(["npm", "test"]).stdout()
  }

  /** Run `npm run build`. */
  @func()
  async build(@argument({ defaultPath: "/", ignore: ["node_modules", ".git", ".dagger/sdk"] }) source: Directory): Promise<string> {
    return this.base(source).withExec(["npm", "run", "build"]).stdout()
  }

  /** Typecheck, test and build. Fails on the first failing step. */
  @func()
  async all(@argument({ defaultPath: "/", ignore: ["node_modules", ".git", ".dagger/sdk"] }) source: Directory): Promise<string> {
    const out = [await this.typecheck(source), await this.test(source), await this.build(source)]
    return out.join("\n")
  }
}
