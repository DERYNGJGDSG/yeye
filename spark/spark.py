import os
import torch
import os
os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
import numpy as np
from torch.utils.data import Dataset, DataLoader
from transformers import BertTokenizer, BertModel,  get_linear_schedule_with_warmup
from sklearn.metrics import accuracy_score, f1_score, matthews_corrcoef
from tqdm import tqdm
import torch.nn as nn
import matplotlib.pyplot as plt
import seaborn as sns
from matplotlib.ticker import MaxNLocator
try:
    from transformers import AdamW
except ImportError:
    try:
        from transformers.optimization import AdamW
    except ImportError:
        from torch.optim import AdamW


# 设置中文显示
plt.rcParams["font.family"] = ["SimHei", "WenQuanYi Micro Hei", "Heiti TC"]
plt.rcParams["axes.unicode_minus"] = False  # 解决负号显示问题

# 数据集配置（注意：key与文件夹名的映射关系）
DATASETS = {
    'sst2': {
        'name': 'SST-2',
        'folder': 'SST-2',  # 对应实际文件夹名
        'num_classes': 2,
        'task_type': 'classification',
        'eval_metric': 'f1',
        'alpha': 0.3,
        'epsilon': 0.1,
        'lr': 2e-5,
        'batch_size': 32,
        'epochs': 4,
        'aux_task': 'intensity_regression'
    },
    'mnli': {
        'name': 'MNLI',
        'folder': 'MNLI',  # 对应实际文件夹名
        'num_classes': 3,
        'task_type': 'classification',
        'eval_metric': 'f1',
        'alpha': 0.2,
        'epsilon': 0.05,
        'lr': 3e-5,
        'batch_size': 16,
        'epochs': 5,
        'aux_task': 'similarity'
    },
    'cola': {
        'name': 'CoLA',
        'folder': 'CoLA',  # 假设实际文件夹名
        'num_classes': 2,
        'task_type': 'classification',
        'eval_metric': 'matthews',
        'alpha': 0.4,
        'epsilon': 0.07,
        'lr': 2e-5,
        'batch_size': 16,
        'epochs': 6,
        'aux_task': 'pos_tagging'
    }
}

# 1. 数据加载与预处理
class TextDataset(Dataset):
    def __init__(self, data_path, tokenizer, max_len=64, task='sst2'):
        self.tokenizer = tokenizer
        self.max_len = max_len
        self.task = task
        self.data = self._load_data(data_path)
        print(f"加载 {task} 数据集，样本数: {len(self.data)}")

    def _load_data(self, data_path):
        dataset = []
        print(f"尝试加载文件: {data_path}")

        if not os.path.exists(data_path):
            print(f"错误: 文件不存在 - {data_path}")
            return []

        with open(data_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
            print(f"文件行数: {len(lines)}")

            for i, line in enumerate(lines):
                # 跳过空行和表头
                if i == 0 or not line.strip():
                    continue

                if self.task == 'mnli':
                    parts = line.strip().split('\t')
                    if len(parts) < 15:
                        print(f"警告: 第 {i} 行格式错误 (MNLI) - {line[:50]}...")
                        continue
                    sentence1 = parts[8]
                    sentence2 = parts[9]
                    label = parts[-1]
                    if label == '-':
                        print(f"警告: 第 {i} 行标签无效 (MNLI) - {label}")
                        continue
                    label_map = {'entailment': 0, 'neutral': 1, 'contradiction': 2}
                    dataset.append({'sentence1': sentence1, 'sentence2': sentence2, 'label': label_map[label]})
                else:
                    parts = line.strip().split('\t')
                    if len(parts) < 2:
                        print(f"警告: 第 {i} 行格式错误 ({self.task}) - {line[:50]}...")
                        continue
                    text = parts[0]
                    label = parts[1]
                    if self.task == 'cola' and label == '?':
                        print(f"警告: 第 {i} 行标签无效 (CoLA) - {label}")
                        continue
                    # 尝试将标签转换为整数
                    try:
                        label_int = int(label)
                        dataset.append({'text': text, 'label': label_int})
                    except ValueError:
                        print(f"警告: 第 {i} 行标签无法转换为整数 - {label}")
                        continue

        print(f"成功加载 {len(dataset)} 条样本")
        return dataset

    def __len__(self):
        return len(self.data)

    def __getitem__(self, idx):
        item = self.data[idx]
        if self.task == 'mnli':
            encoding = self.tokenizer.encode_plus(
                item['sentence1'], item['sentence2'],
                add_special_tokens=True,
                max_length=self.max_len,
                padding='max_length',
                truncation=True,
                return_tensors='pt'
            )
            return {
                'input_ids': encoding['input_ids'].flatten(),
                'attention_mask': encoding['attention_mask'].flatten(),
                'token_type_ids': encoding['token_type_ids'].flatten(),
                'label': torch.tensor(item['label'], dtype=torch.long)
            }
        else:
            encoding = self.tokenizer.encode_plus(
                item['text'],
                add_special_tokens=True,
                max_length=self.max_len,
                padding='max_length',
                truncation=True,
                return_tensors='pt'
            )
            return {
                'input_ids': encoding['input_ids'].flatten(),
                'attention_mask': encoding['attention_mask'].flatten(),
                'label': torch.tensor(item['label'], dtype=torch.long)
            }

# 2. 改进模型架构（结合三项改进）
class EnhancedBERT(nn.Module):
    def __init__(self, num_classes=2, dropout=0.1, task='sst2'):
        super(EnhancedBERT, self).__init__()
        self.bert = BertModel.from_pretrained('bert-base-uncased')
        self.task = task

        # 多任务学习
        self.classifier = nn.Linear(self.bert.config.hidden_size, num_classes)
        if task == 'sst2':
            self.aux_classifier = nn.Linear(self.bert.config.hidden_size, 1)  # 情感强度回归
        elif task == 'mnli':
            self.aux_classifier = nn.Linear(self.bert.config.hidden_size, 1)  # 句子相似度
        elif task == 'cola':
            self.aux_classifier = nn.Linear(self.bert.config.hidden_size, 17)  # 词性标注

        self.dropout = nn.Dropout(dropout)

    def forward(self, input_ids, attention_mask, token_type_ids=None):
        outputs = self.bert(
            input_ids=input_ids,
            attention_mask=attention_mask,
            token_type_ids=token_type_ids,
            output_hidden_states=True
        )

        pooled_output = outputs.pooler_output
        pooled_output = self.dropout(pooled_output)

        logits = self.classifier(pooled_output)
        aux_logits = self.aux_classifier(pooled_output)

        return {
            'logits': logits,
            'aux_logits': aux_logits,
            'hidden_states': outputs.hidden_states
        }

# 3. 训练函数（包含对抗训练）
def train(model, train_dataloader, val_dataloader, optimizer, scheduler, device, epochs, alpha=0.3, epsilon=0.1,
          task='sst2'):
    if task == 'sst2':
        criterion_cls = nn.CrossEntropyLoss()
        criterion_aux = nn.MSELoss()
    elif task == 'mnli':
        criterion_cls = nn.CrossEntropyLoss()
        criterion_aux = nn.MSELoss()
    elif task == 'cola':
        criterion_cls = nn.CrossEntropyLoss()
        criterion_aux = nn.CrossEntropyLoss()

    best_val_score = 0
    history = {'train_loss': [], 'val_score': []}

    for epoch in range(epochs):
        model.train()
        total_loss = 0

        for batch in tqdm(train_dataloader, desc=f'Epoch {epoch + 1}/{epochs}'):
            input_ids = batch['input_ids'].to(device)
            attention_mask = batch['attention_mask'].to(device)
            labels = batch['label'].to(device)

            if task == 'mnli':
                token_type_ids = batch['token_type_ids'].to(device)
                outputs = model(input_ids, attention_mask, token_type_ids)
            else:
                outputs = model(input_ids, attention_mask)

            logits = outputs['logits']
            aux_logits = outputs['aux_logits']

            loss_cls = criterion_cls(logits, labels)

            if task == 'sst2':
                intensity_target = labels.float().unsqueeze(1)
                loss_aux = criterion_aux(aux_logits, intensity_target)
            elif task == 'mnli':
                similarity_target = torch.zeros_like(aux_logits)
                for i, label in enumerate(labels):
                    similarity_target[i] = 2.0 if label == 0 else 1.0 if label == 1 else 0.0
                loss_aux = criterion_aux(aux_logits, similarity_target)
            elif task == 'cola':
                pos_target = torch.randint(0, 17, (labels.size(0),), device=device)
                loss_aux = criterion_aux(aux_logits, pos_target)

            loss = loss_cls + alpha * loss_aux

            if epsilon > 0:
                embeds_init = model.bert.embeddings.word_embeddings(input_ids)
                embeds_init = embeds_init.detach().requires_grad_(True)
                loss.backward(retain_graph=True)
                grad = embeds_init.grad.data
                adv_perturbation = epsilon * torch.sign(grad)
                input_ids_adv = input_ids + torch.clamp(adv_perturbation, -epsilon, epsilon)
                input_ids_adv = input_ids_adv.detach()

                if task == 'mnli':
                    outputs_adv = model(input_ids_adv, attention_mask, token_type_ids)
                else:
                    outputs_adv = model(input_ids_adv, attention_mask)
                logits_adv = outputs_adv['logits']
                loss_adv = criterion_cls(logits_adv, labels)
                total_loss = loss + 0.5 * loss_adv
            else:
                total_loss = loss

            optimizer.zero_grad()
            total_loss.backward()
            optimizer.step()
            scheduler.step()

        if task == 'sst2' or task == 'mnli':
            val_acc, val_f1 = evaluate(model, val_dataloader, device, task)
            val_score = val_f1
            print(f'Epoch {epoch + 1}/{epochs}, Loss: {total_loss.item():.4f}, Val Acc: {val_acc:.4f}, Val F1: {val_f1:.4f}')
        else:
            val_acc, val_mcc = evaluate(model, val_dataloader, device, task)
            val_score = val_mcc
            print(f'Epoch {epoch + 1}/{epochs}, Loss: {total_loss.item():.4f}, Val Acc: {val_acc:.4f}, Val MCC: {val_mcc:.4f}')

        history['train_loss'].append(total_loss.item())
        history['val_score'].append(val_score)

        if val_score > best_val_score:
            best_val_score = val_score
            torch.save(model.state_dict(), f'best_model_{task}.pt')

    return history

# 4. 评估函数
def evaluate(model, dataloader, device, task='sst2'):
    model.eval()
    predictions = []
    true_labels = []

    with torch.no_grad():
        for batch in dataloader:
            input_ids = batch['input_ids'].to(device)
            attention_mask = batch['attention_mask'].to(device)
            labels = batch['label'].to(device)

            if task == 'mnli':
                token_type_ids = batch['token_type_ids'].to(device)
                outputs = model(input_ids, attention_mask, token_type_ids)
            else:
                outputs = model(input_ids, attention_mask)

            logits = outputs['logits']
            _, preds = torch.max(logits, dim=1)
            predictions.extend(preds.cpu().tolist())
            true_labels.extend(labels.cpu().tolist())

    acc = accuracy_score(true_labels, predictions)
    if task == 'sst2' or task == 'mnli':
        f1 = f1_score(true_labels, predictions, average='weighted')
        return acc, f1
    else:
        mcc = matthews_corrcoef(true_labels, predictions)
        return acc, mcc

# 5. 消融实验
def ablation_study(dataset_name, base_dir=r'D:\1\glue'):
    print(f"\n=== 开始 {dataset_name} 数据集的消融实验 ===")
    print(f"数据路径: {base_dir}")

    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    config = DATASETS[dataset_name]
    tokenizer = BertTokenizer.from_pretrained('bert-base-uncased')

    # 使用配置中的实际文件夹名（如SST-2、MNLI）
    folder_name = config['folder']
    train_path = os.path.join(base_dir, f'{folder_name}/train.tsv')
    val_path = os.path.join(base_dir, f'{folder_name}/dev.tsv')

    train_dataset = TextDataset(train_path, tokenizer, task=dataset_name)
    val_dataset = TextDataset(val_path, tokenizer, task=dataset_name)

    if len(train_dataset) == 0 or len(val_dataset) == 0:
        print(f"错误: {dataset_name} 数据集加载失败，样本数为0")
        return {}

    train_dataloader = DataLoader(train_dataset, batch_size=config['batch_size'], shuffle=True)
    val_dataloader = DataLoader(val_dataset, batch_size=config['batch_size'])

    ablations = {
        'baseline': {'dynamic': False, 'multitask': False, 'adversarial': False},
        'dynamic': {'dynamic': True, 'multitask': False, 'adversarial': False},
        'multitask': {'dynamic': False, 'multitask': True, 'adversarial': False},
        'adversarial': {'dynamic': False, 'multitask': False, 'adversarial': True},
        'all': {'dynamic': True, 'multitask': True, 'adversarial': True}
    }

    results = {}

    for abl_name, abl_config in ablations.items():
        print(f"\n=== 消融实验: {abl_name} ===")
        model = EnhancedBERT(num_classes=config['num_classes'], task=dataset_name)
        model.to(device)

        param_optimizer = list(model.named_parameters())
        no_decay = ['bias', 'LayerNorm.bias', 'LayerNorm.weight']
        optimizer_grouped_parameters = []
        lr = config['lr']

        if abl_config['dynamic']:
            layers = [model.bert.embeddings] + list(model.bert.encoder.layer)
            gamma = 0.8
            for i, layer in enumerate(layers):
                optimizer_grouped_parameters.extend([
                    {
                        'params': [p for n, p in layer.named_parameters() if not any(nd in n for nd in no_decay)],
                        'weight_decay': 0.01,
                        'lr': lr * (gamma **(len(layers) - i))
                    },
                    {
                        'params': [p for n, p in layer.named_parameters() if any(nd in n for nd in no_decay)],
                        'weight_decay': 0.0,
                        'lr': lr * (gamma** (len(layers) - i))
                    }
                ])
            optimizer_grouped_parameters.extend([
                {
                    'params': [p for n, p in param_optimizer if 'classifier' in n and not any(nd in n for nd in no_decay)],
                    'weight_decay': 0.01,
                    'lr': lr * 2
                },
                {
                    'params': [p for n, p in param_optimizer if 'classifier' in n and any(nd in n for nd in no_decay)],
                    'weight_decay': 0.0,
                    'lr': lr * 2
                },
                {
                    'params': [p for n, p in param_optimizer if 'aux_classifier' in n and not any(nd in n for nd in no_decay)],
                    'weight_decay': 0.01,
                    'lr': lr * 2
                },
                {
                    'params': [p for n, p in param_optimizer if 'aux_classifier' in n and any(nd in n for nd in no_decay)],
                    'weight_decay': 0.0,
                    'lr': lr * 2
                }
            ])
        else:
            optimizer_grouped_parameters = [
                {
                    'params': [p for n, p in param_optimizer if not any(nd in n for nd in no_decay)],
                    'weight_decay': 0.01,
                    'lr': lr
                },
                {
                    'params': [p for n, p in param_optimizer if any(nd in n for nd in no_decay)],
                    'weight_decay': 0.0,
                    'lr': lr
                }
            ]

        optimizer = AdamW(optimizer_grouped_parameters, lr=lr)
        total_steps = len(train_dataloader) * config['epochs']
        scheduler = get_linear_schedule_with_warmup(
            optimizer,
            num_warmup_steps=int(total_steps * 0.1),
            num_training_steps=total_steps
        )

        history = train(
            model, train_dataloader, val_dataloader, optimizer, scheduler, device,
            epochs=config['epochs'],
            alpha=config['alpha'] if abl_config['multitask'] else 0.0,
            epsilon=config['epsilon'] if abl_config['adversarial'] else 0.0,
            task=dataset_name
        )

        model.load_state_dict(torch.load(f'best_model_{dataset_name}.pt'))
        model.eval()

        if dataset_name == 'sst2' or dataset_name == 'mnli':
            _, score = evaluate(model, val_dataloader, device, dataset_name)
        else:
            _, score = evaluate(model, val_dataloader, device, dataset_name)

        results[abl_name] = score
        print(f"{abl_name} 最终 {config['eval_metric']}: {score:.4f}")

    return results

# 6. 可视化函数
def visualize_results(results):
    """可视化消融实验结果和协同效应"""
    datasets = ['sst2', 'mnli', 'cola']
    strategies = ['baseline', 'dynamic', 'multitask', 'adversarial', 'all']
    strategy_names = ['基线', '动态权重', '多任务学习', '对抗训练', '全部策略']

    # 创建画布
    fig, axes = plt.subplots(1, 2, figsize=(16, 6))

    # 1. 消融实验结果柱状图
    bar_width = 0.15
    positions = np.arange(len(datasets))

    for i, strategy in enumerate(strategies):
        scores = [results[dataset][strategy] for dataset in datasets]
        axes[0].bar(positions + i * bar_width, scores, width=bar_width, label=strategy_names[i])

    axes[0].set_title('消融实验结果对比')
    axes[0].set_xlabel('数据集')
    axes[0].set_ylabel('性能分数')
    axes[0].set_xticks(positions + bar_width * 2)
    axes[0].set_xticklabels(['SST-2', 'MNLI', 'CoLA'])
    axes[0].legend()
    axes[0].grid(axis='y', linestyle='--', alpha=0.7)

    # 2. 协同效应折线图
    for dataset in datasets:
        # 计算每个策略组合相对于基线的提升
        baseline_score = results[dataset]['baseline']
        improvements = [(results[dataset][s] - baseline_score) / baseline_score * 100 for s in strategies]

        axes[1].plot(strategy_names, improvements, marker='o', label=DATASETS[dataset]['name'])

    axes[1].set_title('不同策略组合的协同效应')
    axes[1].set_xlabel('策略组合')
    axes[1].set_ylabel('相对于基线的性能提升 (%)')
    axes[1].legend()
    axes[1].grid(axis='y', linestyle='--', alpha=0.7)
    axes[1].set_xticklabels(strategy_names, rotation=45)

    plt.tight_layout()
    plt.savefig('ablation_results.png', dpi=300, bbox_inches='tight')
    plt.show()

# 7. 主函数
def main():
    # 运行所有数据集的消融实验
    all_results = {}

    for dataset in ['sst2', 'mnli', 'cola']:
        print(f"\n===== 开始 {DATASETS[dataset]['name']} 数据集实验 =====")
        results = ablation_study(dataset)
        all_results[dataset] = results

    # 可视化结果
    if all_results and all(dataset in all_results for dataset in ['sst2', 'mnli', 'cola']):
        visualize_results(all_results)
    else:
        print("警告: 未能收集所有数据集的结果，无法生成可视化图表")

    # 打印最终结果
    print("\n===== 最终实验结果 =====")
    for dataset, results in all_results.items():
        print(f"\n{DATASETS[dataset]['name']} 数据集:")
        for strategy, score in results.items():
            print(f"  {strategy}: {score:.4f}")

if __name__ == "__main__":
    main()