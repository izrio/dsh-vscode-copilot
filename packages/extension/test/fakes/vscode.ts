/** 单元测试用的最小 vscode 模块替身，只实现 ChatViewProvider 用到的部分。 */
export class Uri {
  private constructor(readonly path: string) {}
  static file(path: string): Uri {
    return new Uri(path);
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri([base.path, ...segments].join('/'));
  }
  toString(): string {
    return `vscode-resource:${this.path}`;
  }
}
