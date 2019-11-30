import * as React from 'react';
import * as dateFormat from 'dateformat';
import { postConstruct, injectable, inject } from 'inversify';
import { ThemeConfig } from 'react-select/src/theme';
import { OptionsType } from 'react-select/src/types';
import Select from 'react-select';
import { Styles } from 'react-select/src/styles';
import { MessageService } from '@theia/core/lib/common/message-service';
import { ReactWidget, Message, Widget, StatefulWidget } from '@theia/core/lib/browser';
import { MonitorServiceClientImpl } from './monitor-service-client-impl';
import { MonitorConfig, MonitorService } from '../../common/protocol/monitor-service';
import { AttachedSerialBoard, BoardsService } from '../../common/protocol/boards-service';
import { BoardsConfig } from '../boards/boards-config';
import { BoardsServiceClientImpl } from '../boards/boards-service-client-impl';
import { MonitorModel } from './monitor-model';
import { MonitorConnection } from './monitor-connection';

export namespace SerialMonitorSendField {
    export interface Props {
        readonly onSend: (text: string) => void
    }
    export interface State {
        value: string;
    }
}

export class SerialMonitorSendField extends React.Component<SerialMonitorSendField.Props, SerialMonitorSendField.State> {

    protected inputField: HTMLInputElement | null;

    constructor(props: SerialMonitorSendField.Props) {
        super(props);
        this.state = { value: '' };

        this.handleChange = this.handleChange.bind(this);
        this.handleSubmit = this.handleSubmit.bind(this);
    }

    componentDidMount() {
        if (this.inputField) {
            this.inputField.focus();
        }
    }

    render() {
        return <React.Fragment>
            <input
                tabIndex={-1}
                ref={ref => this.inputField = ref}
                type='text' id='serial-monitor-send'
                autoComplete='off'
                value={this.state.value}
                onChange={this.handleChange} />
            <button className='button' onClick={this.handleSubmit}>Send</button>
            {/* <input className='btn' type='submit' value='Submit' />
            <form onSubmit={this.handleSubmit}>
            </form> */}
        </React.Fragment>
    }

    protected handleChange(event: React.ChangeEvent<HTMLInputElement>) {
        this.setState({ value: event.target.value });
    }

    protected handleSubmit(event: React.MouseEvent<HTMLButtonElement>) {
        this.props.onSend(this.state.value);
        this.setState({ value: '' });
        event.preventDefault();
    }
}

export namespace SerialMonitorOutput {
    export interface Props {
        readonly lines: string[];
        readonly model: MonitorModel;
    }
}

export class SerialMonitorOutput extends React.Component<SerialMonitorOutput.Props> {

    protected anchor: HTMLElement | null;

    render() {
        return <React.Fragment>
            <div style={({ whiteSpace: 'pre', fontFamily: 'monospace' })}>
                {this.props.lines.join('')}
            </div>
            <div style={{ float: 'left', clear: 'both' }} ref={element => { this.anchor = element; }} />
        </React.Fragment>;
    }

    componentDidMount() {
        this.scrollToBottom();
    }

    componentDidUpdate() {
        this.scrollToBottom();
    }

    protected scrollToBottom() {
        if (this.props.model.autoscroll && this.anchor) {
            this.anchor.scrollIntoView();
        }
    }

}

export interface SelectOption<T> {
    readonly label: string;
    readonly value: T;
}

@injectable()
export class MonitorWidget extends ReactWidget implements StatefulWidget {

    static readonly ID = 'serial-monitor';

    @inject(MonitorServiceClientImpl)
    protected readonly serviceClient: MonitorServiceClientImpl;

    @inject(MonitorConnection)
    protected readonly connection: MonitorConnection;

    @inject(MonitorService)
    protected readonly monitorService: MonitorService;

    @inject(BoardsServiceClientImpl)
    protected readonly boardsServiceClient: BoardsServiceClientImpl;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(BoardsService)
    protected readonly boardsService: BoardsService;

    @inject(MonitorModel)
    protected readonly model: MonitorModel;

    protected lines: string[];
    protected chunk: string;
    protected widgetHeight: number;

    /**
     * Do not touch or use it. It is for setting the focus on the `input` after the widget activation.
     */
    protected focusNode: HTMLElement | undefined;

    constructor() {
        super();

        this.id = MonitorWidget.ID;
        this.title.label = 'Serial Monitor';
        this.title.iconClass = 'arduino-serial-monitor-tab-icon';

        this.lines = [];
        this.chunk = '';
        this.scrollOptions = undefined;
        // TODO onError
    }

    @postConstruct()
    protected init(): void {
        this.toDisposeOnDetach.pushAll([
            this.serviceClient.onRead(({ data }) => {
                this.chunk += data;
                const eolIndex = this.chunk.indexOf('\n');
                if (eolIndex !== -1) {
                    const line = this.chunk.substring(0, eolIndex + 1);
                    this.chunk = this.chunk.slice(eolIndex + 1);
                    this.lines.push(`${this.model.timestamp ? `${dateFormat(new Date(), 'H:M:ss.l')} -> ` : ''}${line}`);
                    this.update();
                }
            }),
            this.boardsServiceClient.onBoardsConfigChanged(config => {
                const { selectedBoard, selectedPort } = config;
                if (selectedBoard && selectedPort) {
                    this.boardsService.getAttachedBoards().then(({ boards }) => {
                        if (boards.filter(AttachedSerialBoard.is).some(board => BoardsConfig.Config.sameAs(config, board))) {
                            this.connect();
                        }
                    });
                }
            })]);
        this.update();
    }

    clearConsole(): void {
        this.chunk = '';
        this.lines = [];
        this.update();
    }

    storeState(): MonitorModel.State {
        return this.model.store();
    }

    restoreState(oldState: MonitorModel.State): void {
        this.model.restore(oldState);
    }

    onBeforeAttach(msg: Message): void {
        super.onBeforeAttach(msg);
        this.clearConsole();
    }

    protected onAfterAttach(msg: Message): void {
        super.onAfterAttach(msg);
        this.connect();
    }

    protected onBeforeDetach(msg: Message): void {
        super.onBeforeDetach(msg);
        if (this.connection.connectionId) {
            this.connection.disconnect();
        }
    }

    protected onResize(msg: Widget.ResizeMessage): void {
        super.onResize(msg);
        this.widgetHeight = msg.height;
        this.update();
    }

    protected async connect(): Promise<void> {
        const config = await this.getConnectionConfig();
        if (config) {
            this.connection.connect(config);
        }
    }

    protected async getConnectionConfig(): Promise<MonitorConfig | undefined> {
        const baudRate = this.model.baudRate;
        const { boardsConfig } = this.boardsServiceClient;
        const { selectedBoard, selectedPort } = boardsConfig;
        if (!selectedBoard) {
            this.messageService.warn('No boards selected.');
            return;
        }
        const { name } = selectedBoard;
        if (!selectedPort) {
            this.messageService.warn(`No ports selected for board: '${name}'.`);
            return;
        }
        const attachedBoards = await this.boardsService.getAttachedBoards();
        const connectedBoard = attachedBoards.boards.filter(AttachedSerialBoard.is).find(board => BoardsConfig.Config.sameAs(boardsConfig, board));
        if (!connectedBoard) {
            return;
        }

        return {
            baudRate,
            board: selectedBoard,
            port: selectedPort
        }
    }

    protected get lineEndings(): OptionsType<SelectOption<MonitorModel.EOL>> {
        return [
            {
                label: 'No Line Ending',
                value: ''
            },
            {
                label: 'Newline',
                value: '\n'
            },
            {
                label: 'Carriage Return',
                value: '\r'
            },
            {
                label: 'Both NL & CR',
                value: '\r\n'
            }
        ]
    }

    protected get baudRates(): OptionsType<SelectOption<MonitorConfig.BaudRate>> {
        const baudRates: Array<MonitorConfig.BaudRate> = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];
        return baudRates.map(baudRate => ({ label: baudRate + ' baud', value: baudRate }));
    }

    protected render(): React.ReactNode {
        const { baudRates, lineEndings } = this;
        const lineEnding = lineEndings.find(item => item.value === this.model.lineEnding) || lineEndings[1]; // Defaults to `\n`.
        const baudRate = baudRates.find(item => item.value === this.model.baudRate) || baudRates[4]; // Defaults to `9600`.
        return <div className='serial-monitor-container'>
            <div className='head'>
                <div className='send'>
                    <SerialMonitorSendField onSend={this.onSend} />
                </div>
                <div className='config'>
                    {this.renderSelectField('arduino-serial-monitor-line-endings', lineEndings, lineEnding, this.onChangeLineEnding)}
                    {this.renderSelectField('arduino-serial-monitor-baud-rates', baudRates, baudRate, this.onChangeBaudRate)}
                </div>
            </div>
            <div id='serial-monitor-output-container'>
                <SerialMonitorOutput model={this.model} lines={this.lines} />
            </div>
        </div>;
    }

    protected readonly onSend = (value: string) => this.doSend(value);
    protected async doSend(value: string) {
        const { connectionId } = this.connection;
        if (connectionId) {
            this.monitorService.send(connectionId, value + this.model.lineEnding);
        }
    }

    protected readonly onChangeLineEnding = (option: SelectOption<MonitorModel.EOL>) => {
        this.model.lineEnding = typeof option.value === 'string' ? option.value : MonitorModel.EOL.DEFAULT;
    }

    protected readonly onChangeBaudRate = async (option: SelectOption<MonitorConfig.BaudRate>) => {
        await this.connection.disconnect();
        this.model.baudRate = typeof option.value === 'number' ? option.value : MonitorConfig.BaudRate.DEFAULT;
        this.clearConsole();
        const config = await this.getConnectionConfig();
        if (config) {
            await this.connection.connect(config);
        }
    }

    protected renderSelectField<T>(
        id: string,
        options: OptionsType<SelectOption<T>>,
        defaultValue: SelectOption<T>,
        onChange: (option: SelectOption<T>) => void): React.ReactNode {

        const height = 25;
        const styles: Styles = {
            control: (styles, state) => ({
                ...styles,
                width: 200,
                color: 'var(--theia-ui-font-color1)'
            }),
            dropdownIndicator: styles => ({
                ...styles,
                padding: 0
            }),
            indicatorSeparator: () => ({
                display: 'none'
            }),
            indicatorsContainer: () => ({
                padding: '0px 5px'
            }),
            menu: styles => ({
                ...styles,
                marginTop: 0
            })
        };
        const theme: ThemeConfig = theme => ({
            ...theme,
            borderRadius: 0,
            spacing: {
                controlHeight: height,
                baseUnit: 2,
                menuGutter: 4
            }
        });
        const DropdownIndicator = () => {
            return (
                <span className='fa fa-caret-down caret'></span>
            );
        };
        return <Select
            options={options}
            defaultValue={defaultValue}
            onChange={onChange}
            components={{ DropdownIndicator }}
            theme={theme}
            styles={styles}
            maxMenuHeight={this.widgetHeight - 40}
            classNamePrefix='sms'
            className='serial-monitor-select'
            id={id}
        />
    }
}
