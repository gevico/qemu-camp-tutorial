# RUST 实验 - GPIO I2C 控制器（QTest）  

!!! note "主要贡献者"  

    - 作者：[@ovwxxwvo](https://github.com/ovwxxwvo)  

完整实现代码可参考仓库([qemu-camp-2026-exper-ovwxxwvo](https://github.com/gevico/qemu-camp-2026-exper-ovwxxwvo))  

---  

### 📁 项目主要目录结构  
```  
./rust/hw/i2c/  
├── i2c_core             // i2c通用核心实现  
│   └── src  
│       ├── core.rs  
│       └── lib.rs  
├── i2c_slave            // i2c各种从机外设实现  
│   └── src  
│       ├── at24c02.rs  
│       └── lib.rs  
├── gpio_i2c             // i2c具体控制器实现  
│   └── src  
│       ├── bindings.rs  
│       ├── registers.rs  
│       ├── device.rs  
│       └── lib.rs  
```  

- 项目文件结构的设计是为了减少QEMU的C代码对RUST代码的多次调用。  
- 主控设备实现的crate(`gpio_i2c`)是唯一提供给QEMU调用的接口，每个主控都是独立的crate。  
- 主控总线和从机特性的实现的crate(`i2c_core`)仅在RUST内部供主控和从机的实现使用。  
- 从机外设的实现将在crate(`i2c_slave`)以mod形式存在，每个从机外设都为独立的mod。  

### 🛠️ 项目构建所需修改文件  
```  
./hw/i2c/Kconfig                    // I2C驱动配置，新增GPIO_I2C编译项，关联Rust实现驱动  
./hw/riscv/Kconfig                  // RISC-V主板配置，GEVICO_G233平台新增GPIO_I2C外设依赖  

./rust/Cargo.toml                   // 顶层workspace添加相应crate  

./rust/hw/i2c/Kconfig               // 添加子项  
./rust/hw/i2c/meson.build           // 添加子项  

./rust/hw/i2c/gpio_i2c/meson.build  // 注意添加bindgen相关  
./rust/hw/i2c/gpio_i2c/Cargo.toml   // 注意依赖相对路径层级  
```  

- `./rust/Cargo.toml`顶层`workspace`添加相应的`crate`，这样lsp才能生效，必要时`cargo clean`。  
- `./rust/hw/i2c/gpio_i2c/meson.build`文件中`_gpio_i2c_rs`需要添加`{'.': _gpio_i2c_bindings_inc_rs},` 。  

### 🛠️ 项目混合编程对接文件  
```  
./rust/hw/i2c/gpio_i2c/wrapper.h        // 专供bindgen解析的适配头，修复工具解析报错并引入标准C头文件  
./rust/hw/i2c/gpio_i2c/src/bindings.rs  // 导入bindgen生成的QEMU的C接口绑定代码，Rust通过其调用C侧接口  

./include/hw/i2c/gpio_i2c.h             // 声明C接口函数符号，供C代码调用Rust实现  
./rust/hw/i2c/gpio_i2c/src/lib.rs       // 导出Rust功能实现，对接C声明接口函数符号  

./include/hw/riscv/g233.h               // 声明项目相关内存映射枚举  
./hw/riscv/g233.c                       // 调用控制器create实现  
```  

- `gpio_i2c_create`和`gpio-i2c`这两个符号在C和RUST中是对应的。  
- 主要涉及文件`./include/hw/i2c/gpio_i2c.h`和`./rust/hw/i2c/gpio_i2c/src/lib.rs`。  

---  

### 🧩 GPIO_I2C主控的极简实现框架  
```  
// QEMU硬件抽象层  
pub struct GPIOI2CRegisters {}  // 寄存器，存放设备所有寄存器  
pub struct GPIOI2CState {}      // QOM设备模型，存放设备运行状态  
pub struct GPIOI2CClass {}      // QOM设备类，存放设备固定属性  

// 业务特性，强制设备挂载系统总线并规定设备唯一ID  
trait GPIOI2CImpl: SysBusDeviceImpl + IsA<GPIOI2CState> {}  

// QEMU框架适配层  
impl GPIOI2CClass {}                           // 保存设备ID，调用父类初始化  
unsafe impl ObjectType for GPIOI2CState {}     // 绑定实例类对象，设备命名供QEMU使用  
impl GPIOI2CImpl for GPIOI2CState {}           // 定义设备ID  
impl ObjectImpl for GPIOI2CState {}            // 绑定设备完整生命周期函数  
impl DeviceImpl for GPIOI2CState {}            // 启用设备，创建设备硬件资源  
impl ResettablePhasesImpl for GPIOI2CState {}  // 复位回调，虚拟机复位时恢复硬件初始状态  
impl SysBusDeviceImpl for GPIOI2CState {}      // 挂载设备到系统总线，绑定MMIO访问入口  

// QEMU业务接口层  
impl GPIOI2CRegisters {}                       // 实现寄存器读写及复位逻辑  
impl GPIOI2CState {}                           // 实现数据收发工具函数  

// 导出设备创建函数  
pub unsafe extern "C" fn gpio_i2c_create()     // 创建实例化设备，供QEMU的C代码调用  
```  

- GPIO_I2C主控设备为极简实现，未实现中断逻辑和复位逻辑。(仿pl011)  
- 寄存器的地址偏移和特定寄存器结构体在同crate的`registers.rs`中定义。  
- I2C总线在`i2c_core`的crate中的`core.rs`中定义。  
- I2C从机在`i2c_slave`的crate中进行不同外设的定义。  

### 🔗 GPIO_I2C主控的业务函数调用链条  
```  
gpio_i2c_create  
  └> GPIOI2CState::new  
  |    └> GPIOI2CState::init  
  |         └> MemoryRegion::init_io - GPIOI2C_OPS  
  |         └> GPIOI2CRegisters - Default::default()  
  |         └> I2C_Bus::new  
  └> GPIOI2CState::sysbus_realize  
       └> GPIOI2CState::realize -> I2CBus::attach -> AT24C02Slave::new  
```  
```  
qtest_readl  -> GPIOI2C_OPS.read  -> GPIOI2CState::read  -> GPIOI2CRegisters::read  

qtest_writel -> GPIOI2C_OPS.write -> GPIOI2CState::write -> GPIOI2CRegisters::write  
  ┌-----------------------------------------------------------┘  
  └> I2C_Bus::transfer_read  -> AT24C02Slave::recv  
  └> I2C_Bus::transfer_write -> AT24C02Slave::send  
```  

- `GPIOI2CState::init`初始化由`GPIOI2CState::new`构造间接调用。  
- `GPIOI2CState::realize`实体化由`GPIOI2CState::sysbus_realize`实现间接调用。  
- `I2CBus`分别在`GPIOI2CState`的`init`和`realize`中进行创建和从机挂载。  
- I2C主从数据传输仅由写控制寄存器触发，写入其余寄存器和读取所有寄存器不触发总线通信。  

---  

### 🔄 I2C协议数据流转  
```  
             sys-bus                      i2c-bus  
 risc-v --<----------->-- i2c-master --<----------->-- i2c-slave  
processor                 controller                   peripheral  
```  
```  
   /-SDA-<->- start+[7addr+1rw](tx)+n|ack(rx)+[8data](tx)+n|ack(rx)+stop -<->-SDA-\  
I2C peripheral                                                                I2C controller  
   \-SCL----- ------            ...12345678...123456789...         ----- -----SCL-/  
```  

- I2C协议，两线一时钟(SCL)一数据(SDA)，单线进行数据收发。  
- 主控选择哪个从机通信，依靠传输数据包内的设备地址，有独立地址寄存器。  
- 启停信号由主控写控制寄存器触发，不作保存。  
- 应答信号由字节接收方发起，应答判定结果保存在状态寄存器。  
- 7位地址+1位读写标记，构成8位保存在地址寄存器，由主控发起。  
- 8位数据，保存在数据寄存器。  

### 🧩 I2C_BUS的实现框架  
```  
pub struct I2CBus {  
    devices: Vec<Box<dyn I2CSlave>>,  // 挂载在总线上的从机列表  
    current_addr: Option<u8>,         // 当前正在通信的从机地址  
    is_recv: bool                     // 本次传输是主机读或主机写的标记  
}  

impl I2CBus {  
    pub fn new             // 创建总线，初始化设备列表及当前寻址地址  
    pub fn device_count    // 统计总线上挂载的从设备数量  
    pub fn is_busy         // 判断总线是否正在传输  

    pub fn attach          // 挂载从机到总线  
    pub fn start_transfer  // 返回开始信号，保存地址，确定主机读写  
    pub fn end_transfer    // 返回结束信号，设置地址为空  
    pub fn send            // 发送数据，调用从机发送函数  
    pub fn recv            // 接收数据，调用从机接收函数  
    pub fn transfer_write  // 封装完整写流程：起始写传输+连续写入字节+结束传输  
    pub fn transfer_read   // 封装完整读流程：起始读传输+连续读取字节+结束传输  
}  
```  
- I2C_Bus的实现是在RUST实验一核心代码上稍作修改完成。  

### 🧩 I2C_SLAVE的实现框架  
```  
pub struct AT24C02Slave {  
    pub addr      : u8,         // 从机设备地址  
    pub regs      : [u8; 256],  // EEPROM存储数组  
    pub pointer   : u8,         // 存储读写指针  
    pub first_byte: bool,       // 标记首字节  
}  

impl I2CSlave for AT24C02Slave {  
    fn address  // 获取设备地址  
    fn event    // 响应总线事件  
    fn send     // 发送主机数据，并设置存储读写指针  
    fn recv     // 接收主机数据，并设置存储读写指针  
}  
```  
- AT24C02_Slave的实现是在RUST实验一测试代码上稍作修改完成。  

---  

### 📦 GPIO_I2C主控的寄存器写根据I2C协议的实现  
```  
impl GPIOI2CRegisters {  

    pub(self) fn read(&mut self, offset: RegisterOffset) -> u32 {  
    }  

    pub(self) fn write(&mut self, offset: RegisterOffset, value: u32, device: &GPIOI2CState) -> bool {  
        use RegisterOffset::*;  
        match offset {  
            ADDR     => self.addr     = Addr::from(value),  
            DATA     => self.data     = value,  

        // I2C主从数据传输由写控制寄存器触发，需实现5个逻辑分支：  
            CTRL     => {  
                let mut i2c_bus = device.i2c_bus.borrow_mut();  
                let mut ctrl = Ctrl::from(value);  
                match (ctrl.en(), ctrl.start(), ctrl.stop(), ctrl.rw()) {  

            // 使能+起始信号：发起传输，更新总线及寄存器状态  
                    (true, true, false, _) => {  
                        let addr = u32::from(self.addr) as u8;  
                        let ret  = i2c_bus.start_transfer(addr, ctrl.rw());  
                        self.status.set_busy(i2c_bus.is_busy());  
                        self.status.set_ack(ret == 0);  
                        self.status.set_done(true);  
                    },  

            // 使能+停止信号：结束传输，更新总线及寄存器状态  
                    (true, false, true, false) => {  
                        i2c_bus.end_transfer();  
                        self.status.set_busy(i2c_bus.is_busy());  
                        self.status.set_done(true);  
                    },  

            // 使能+无起止+写模式：读寄存器发送数据，更新总线及寄存器状态  
                    (true, false, false, false) => {  
                        let data = self.data as u8;  
                        let ret  = i2c_bus.send(data);  
                        self.status.set_busy(i2c_bus.is_busy());  
                        self.status.set_ack(ret == 0);  
                        self.status.set_done(true);  
                    },  

            // 使能+无起止+读模式：接收数据写寄存器，更新总线及寄存器状态  
                    (true, false, false, true) => {  
                        let data = i2c_bus.recv();  
                        self.data = data as u32;  
                        self.status.set_busy(i2c_bus.is_busy());  
                        self.status.set_done(true);  
                    },  

            // 无效控制组合，不执行任何操作  
                    _ => {},  
                };  
                ctrl.set_start(false);  
                ctrl.set_stop(false);  
                self.ctrl = ctrl  
            },  
            STATUS   => self.status   = Status::from(value),  
            PRESCALE => self.prescale = value,  
        }  
        false  
    }  

}  
```  
- I2C主从数据传输由写控制寄存器触发，需实现5个逻辑分支：  
  - 使能+起始信号：发起传输，更新总线及寄存器状态  
  - 使能+停止信号：结束传输，更新总线及寄存器状态  
  - 使能+无起止+写模式：读寄存器发送数据，更新总线及寄存器状态  
  - 使能+无起止+读模式：接收数据写寄存器，更新总线及寄存器状态  
  - 无效控制组合，不执行任何操作  

---  

### 📝 总结  

- 文中目录结构、文件清单、代码框架均可直接复用，更换协议就能移植其他外设。  
- RUST和C的多语言混合编程工程搭建繁琐，可在着手实现具体逻辑前修改涉及文件。  
- 了解QEMU设备的实现框架，理清函数调用链路，关键业务代码是实现主控寄存器基于协议的读写逻辑。  
- 项目未用到GDB调试，有待进一步学习，不懂知识由豆包协助推进。  

