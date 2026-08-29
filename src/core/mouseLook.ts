/**
 * 鼠标自由视角:把鼠标位移累积成一对绕车的偏航/俯仰角,交给 `ChaseCamera`
 * 去转镜头。**只影响相机,不参与物理**——`?test=1` 下不注册任何监听器,
 * 逐帧复现那条契约不受影响。
 *
 * 用指针锁定(Pointer Lock)而不是读光标坐标:光标坐标会被窗口边缘卡住,
 * 转到一半就转不动了,这也是所有第一/第三人称游戏都用指针锁定的原因。
 * 点画面进入锁定,Esc 退出——Esc 同时也是暂停键,两者叠在一起是符合直觉的
 * (松开鼠标的同时把游戏停下)。
 *
 * 松手不动之后会自动回正,回正前留一段停顿(`CAMERA.lookRecenterDelay`)。
 * 不回正的话,视角很容易被落在侧面然后忘记摆回来,车就没法开了。
 */
export class MouseLook {
  /** 目标偏航(弧度,0 = 正常车尾视角,正 = 向右看)。 */
  yaw = 0;
  /** 目标俯仰(弧度,正 = 从上往下看)。 */
  pitch = 0;

  private readonly element: HTMLElement;
  private readonly sensitivity: number;
  private readonly yawLimit: number;
  private readonly pitchMin: number;
  private readonly pitchMax: number;
  private readonly recenterDelay: number;
  private readonly recenterLambda: number;
  /** 距离上一次鼠标移动过去了多久(秒)。 */
  private idleTime = 0;
  private locked = false;

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (!this.locked) {
      return;
    }
    this.idleTime = 0;
    this.yaw = clampTo(this.yaw + event.movementX * this.sensitivity, this.yawLimit);
    this.pitch = Math.min(
      this.pitchMax,
      Math.max(this.pitchMin, this.pitch + event.movementY * this.sensitivity),
    );
  };

  private readonly onLockChange = (): void => {
    this.locked = document.pointerLockElement === this.element;
  };

  private readonly onClick = (): void => {
    if (!this.locked) {
      void this.element.requestPointerLock?.();
    }
  };

  constructor(
    element: HTMLElement,
    options: {
      sensitivity: number;
      yawLimit: number;
      pitchMin: number;
      pitchMax: number;
      recenterDelay: number;
      recenterLambda: number;
    },
  ) {
    this.element = element;
    this.sensitivity = options.sensitivity;
    this.yawLimit = options.yawLimit;
    this.pitchMin = options.pitchMin;
    this.pitchMax = options.pitchMax;
    this.recenterDelay = options.recenterDelay;
    this.recenterLambda = options.recenterLambda;

    element.addEventListener('click', this.onClick);
    document.addEventListener('pointerlockchange', this.onLockChange);
    document.addEventListener('mousemove', this.onMouseMove);
  }

  /** 每个固定步调一次。停顿够久就把视角拉回车尾。 */
  update(dt: number): void {
    this.idleTime += dt;
    if (this.idleTime < this.recenterDelay) {
      return;
    }
    const k = 1 - Math.exp(-this.recenterLambda * dt);
    this.yaw += (0 - this.yaw) * k;
    this.pitch += (0 - this.pitch) * k;
  }

  /** 重开一局时立刻回正,不要让上一局的视角留到下一局。 */
  reset(): void {
    this.yaw = 0;
    this.pitch = 0;
    this.idleTime = 0;
  }

  dispose(): void {
    this.element.removeEventListener('click', this.onClick);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    document.removeEventListener('mousemove', this.onMouseMove);
  }
}

function clampTo(value: number, limit: number): number {
  return Math.min(limit, Math.max(-limit, value));
}
